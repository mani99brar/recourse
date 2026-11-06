#!/usr/bin/env bash
# LOCAL ONLY. Rehearses the whole deploy-and-wire order on two throwaway anvil nodes (ports 8610 for the Hedera
# side, 8611 for the Arbitrum side) with throwaway keystores made in a temp directory and deleted on exit.
# Sends nothing to any testnet. Run it under the suite lock:
#   SUITE_LOCK_FILE=$HOME/.local/state/recourse/suite.lock flock -o -w 900 "$SUITE_LOCK_FILE" bash ops/wire/rehearse.sh
#
# What runs (the same order as order.md):
#   Hedera:    DeployLocal for the mocks (HTS, PRNG, USDC facade, router, LINK), then hedera.sh deploy, associate,
#              record with the throwaway deployer (the real deploy script, not a stand-in).
#   Arbitrum:  DeployLocal (mock arbitrator, template registry, router, LINK), with the throwaway deployer taking
#              ownership by Ownable2Step, because the local script deploys from an unlocked anvil account.
#   Wiring:    steps 00 to 10, dry run first and then --send, each with its read-back.
# Own file names are used everywhere: deployments/{hedera,arbitrum,wiring}.wire-rehearsal.local.json.
# They are deleted on exit unless KEEP=1. REHEARSE_HALF_LOCK=1 locks Claims alone before step 09, so 09 has to
# finish a half lock (the vault) instead of running the Lock script. The local case's claimTimeout is Hedera's
# unreduced, so the run also checks that the read-back warns about the relay budget and that 09 refuses to lock it
# until LOCK_IGNORE_RELAY_BUDGET=1.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT=$PWD
export PATH="$HOME/.local/bin:$PATH"
HP=${REHEARSE_HEDERA_PORT:-8610}; AP=${REHEARSE_ARB_PORT:-8611}
case "$HP$AP" in 861[0-9]861[0-9]) ;; *) echo "rehearse: ports must be in 8610-8619" >&2; exit 1 ;; esac
HC=18610; AC=18611    # chain ids of the two nodes, apart from other runs' broadcast folders
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
[ "$avail" -ge 700 ] || { echo "rehearse: only $avail MB free; wait and retry" >&2; exit 1; }

HF=hedera.wire-rehearsal.local.json; AF=arbitrum.wire-rehearsal.local.json; WF=wiring.wire-rehearsal.local.json
BASE=hedera.wire-base.local.json
D=$ROOT/deployments
rm -f "$D/$HF" "$D/$AF" "$D/$WF" "$D/$BASE"
TMP=$(mktemp -d); PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$TMP"
  rm -rf "$ROOT"/contracts/broadcast/*/"$HC" "$ROOT"/contracts/broadcast/*/"$AC"
  if [ "${KEEP:-0}" != 1 ]; then rm -f "$D/$HF" "$D/$AF" "$D/$WF" "$D/$BASE"; fi
}
trap cleanup EXIT

anvil --port "$HP" --chain-id "$HC" --silent & PIDS+=($!)
anvil --port "$AP" --chain-id "$AC" --silent & PIDS+=($!)
HR=http://127.0.0.1:$HP; AR=http://127.0.0.1:$AP
for r in $HR $AR; do for _ in $(seq 1 50); do cast chain-id --rpc-url "$r" >/dev/null 2>&1 && break; sleep 0.2; done; done

# Throwaway keystores; the password goes through the environment, never argv.
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TMP/pass"
ROLES=(deployer ops-hedera ops-arb precheck-signer platform scheme)
for role in "${ROLES[@]}"; do
  CAST_PASSWORD=$(cat "$TMP/pass") cast wallet new "$TMP" "$role.json" >/dev/null
  cp "$TMP/pass" "$TMP/$role.json.pass"; chmod 600 "$TMP/$role.json.pass"
done
addr() { cast wallet address --keystore "$TMP/$1.json" --password-file "$TMP/$1.json.pass"; }
for role in "${ROLES[@]}"; do
  for r in $HR $AR; do cast rpc anvil_setBalance "$(addr "$role")" 0x56BC75E2D63100000 --rpc-url "$r" >/dev/null; done
done
DEV0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   # anvil's public default account 0, unlocked on anvil only
export KEYSTORE_DIR=$TMP WIRE_LOCAL=1 HEDERA_RPC_URL_1=$HR ARB_RPC_URL=$AR
export HEDERA_FILE=$HF ARBITRUM_FILE=$AF WIRING_FILE=$WF HEDERA_STATE_DIR=$TMP/state HEDERA_REHEARSAL=1
export RECOURSE_ENV_FILE=/nonexistent

echo "== Hedera side: mocks, then the real deploy script"
(cd contracts && HEDERA_LOCAL_FILE=$BASE forge script script/hedera/DeployLocal.s.sol --rpc-url "$HR" --broadcast \
  --unlocked --sender "$DEV0" >/dev/null)
export HEDERA_ROUTER=$(jq -r .local.router "$D/$BASE") HEDERA_LINK=$(jq -r .local.link "$D/$BASE")
SIM=$(jq -r .local.simulator "$D/$BASE")
export POOL_ADDRESS=$(addr scheme) PRECHECK_SIGNER_ADDRESS=$(addr precheck-signer) RULING_RELAYER_ADDRESS=$(addr ops-hedera)
export RECOURSE_CASE_ADDRESS=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720   # placeholder, set to the real case in step 1
export HEDERA_BRIDGE_MODE=Both REHEARSAL_BASE_FILE=$BASE REHEARSAL_PLATFORM=$(addr platform)
export REHEARSAL_SHOP=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
HSH=contracts/script/hedera/hedera.sh
$HSH deploy --broadcast
$HSH associate --broadcast
$HSH record
unset HEDERA_ROUTER

echo "== Arbitrum side: mocks and RecourseCase, ownership to the deployer"
(cd contracts && ARBITRUM_LOCAL_FILE=$AF LOCAL_CLAIMS_PEER=$RECOURSE_CASE_ADDRESS LOCAL_HEDERA_RPC_URL=$HR LOCAL_ARB_RPC_URL=$AR \
  forge script script/arbitrum/DeployLocal.s.sol --rpc-url "$AR" --broadcast --unlocked --sender "$DEV0" 2>&1 | tail -n 6)
CASE=$(jq -r .contracts.case.address "$D/$AF")
cast send "$CASE" 'transferOwnership(address)' "$(addr deployer)" --rpc-url "$AR" --unlocked --from "$DEV0" >/dev/null
cast send "$CASE" 'acceptOwnership()' --rpc-url "$AR" --keystore "$TMP/deployer.json" --password-file "$TMP/deployer.json.pass" >/dev/null

# Mock-only setup: LINK for the ops roles (the simulator's faucet is open), the platform's mock USDC.
# The Arbitrum DeployLocal builds its CCIP simulator first from the same account, so on a fresh node it sits at the
# same address as the Hedera one; the check below proves it is the simulator that made this node's LINK.
ASIM=$SIM
[ "$(cast call "$ASIM" 'configuration()(uint64,address,address,address,address,address,address)' --rpc-url "$AR" | sed -n 5p)" = "$(jq -r .mocks.link "$D/$AF")" ] \
  || { echo "rehearse: simulator guess does not match this node's LINK" >&2; exit 1; }
cast send "$SIM" 'requestLinkFromFaucet(address,uint256)' "$(addr ops-hedera)" 100000000000000000000 --rpc-url "$HR" --unlocked --from "$DEV0" >/dev/null
cast send "$ASIM" 'requestLinkFromFaucet(address,uint256)' "$(addr ops-arb)" 100000000000000000000 --rpc-url "$AR" --unlocked --from "$DEV0" >/dev/null
USDC=0x0000000000000000000000000000000000068cDa
cast send "$USDC" 'associate()' --rpc-url "$HR" --keystore "$TMP/platform.json" --password-file "$TMP/platform.json.pass" >/dev/null
cast send "$USDC" 'mint(address,uint256)' "$(addr platform)" 10000000000 --rpc-url "$HR" --unlocked --from "$DEV0" >/dev/null

W=ops/wire
step() { echo; echo "== $*"; }
step "00 read-back before wiring (peers not expected yet)"
EXPECT_PEERS=0 $W/00-readback.sh
step "01 peer on Hedera: dry run, then send"
$W/01-peer-hedera.sh; $W/01-peer-hedera.sh --send
step "02 peer on Arbitrum"
$W/02-peer-arbitrum.sh; $W/02-peer-arbitrum.sh --send
step "03 Claims LINK (target 3 LINK)"
export CLAIMS_LINK_TARGET=3 CASE_LINK_TARGET=12 FEE_POOL_TARGET_ETH=0.06
$W/03-fund-claims.sh; $W/03-fund-claims.sh --send
step "04 Case LINK (target 12 LINK; the local deploy gave it 10)"
$W/04-fund-case-link.sh; $W/04-fund-case-link.sh --send
step "05 fee pool (target 0.06 ETH; the local deploy gave it 0.05)"
$W/05-fund-fee-pool.sh; $W/05-fund-fee-pool.sh --send
step "06 extra args (read back; Case set to a V2 value with 200000 gas, the only form setExtraArgs takes)"
EXTRA_ARGS_ARBITRUM=0x181dcf100000000000000000000000000000000000000000000000000000000000030d400000000000000000000000000000000000000000000000000000000000000001 $W/06-set-extra-args.sh --send
step "07 platform deposit"
$W/07-deposit.sh 5000000000; $W/07-deposit.sh 5000000000 --send
step "08 setRequired"
$W/08-set-required.sh 5000000000; $W/08-set-required.sh 5000000000 --send
step "re-run of 01, 03 and 07 sends nothing"
$W/01-peer-hedera.sh --send; $W/03-fund-claims.sh --send
$W/07-deposit.sh 5000000000 --send | tee "$TMP/07-rerun.log"
grep -q 'nothing to deposit' "$TMP/07-rerun.log" || { echo "rehearse: a re-run of 07 deposited again" >&2; exit 1; }
step "read-back and record before the lock"
$W/00-readback.sh --record | tee "$TMP/00-record.log"
# The local case gets Hedera's locked claimTimeout as it is (contracts/script/arbitrum/DeployLocal.s.sol), not less
# the relay budget as the testnet deploy gives it; the read-back must say so, and 09 must refuse to lock it as it is.
KT=$(cast call "$CASE" 'claimTimeout()(uint64)' --rpc-url "$AR" | awk '{print $1}')
LT=$(jq -r .locked.claimTimeout packages/shared/vectors/params.json)
SHORT=0; [ $((LT - KT)) -lt "${CASE_RELAY_BUDGET:-7200}" ] && SHORT=1
if [ "$SHORT" = 1 ]; then
  grep -q 'WARN claimTimeout' "$TMP/00-record.log" || { echo "rehearse: the read-back did not warn about the relay budget" >&2; exit 1; }
else
  grep -q 'ok   claimTimeout: RecourseCase' "$TMP/00-record.log" || { echo "rehearse: the read-back did not pass the relay budget" >&2; exit 1; }
fi
step "09 lock Hedera, 10 lock Arbitrum"
if [ "${REHEARSE_HALF_LOCK:-0}" = 1 ]; then
  # A lock that died after Claims locked: set Claims' locked parameters and lock it alone, then let 09 finish.
  P=packages/shared/vectors/params.json; L() { jq -r ".locked.$1" "$P"; }
  HCL=$(jq -r .contracts.claims.address "$D/$HF")
  cast send "$HCL" 'setParams((uint64,uint64,uint256,uint256,uint16,uint256,uint64,uint8))' \
    "($(L contestWindow),$(L claimTimeout),$(L courtFeeUsdc),$(L handlingBase),$(L handlingBps),$(L handlingCap),$(L resendGap),$(L maxSends))" \
    --rpc-url "$HR" --keystore "$TMP/deployer.json" --password-file "$TMP/deployer.json.pass" >/dev/null
  cast send "$HCL" 'lockConfig()' --rpc-url "$HR" --keystore "$TMP/deployer.json" --password-file "$TMP/deployer.json.pass" >/dev/null
  echo "half lock made: Claims locked, vault not"
elif [ "$SHORT" = 1 ]; then
  if $W/09-lock-hedera.sh > "$TMP/09-refuse.log" 2>&1 || ! grep -q 'refusing to lock' "$TMP/09-refuse.log"; then
    cat "$TMP/09-refuse.log" >&2; echo "rehearse: 09 did not refuse a case short of the relay budget" >&2; exit 1
  fi
  echo "09 refused the case's claimTimeout (relay budget), as it should; locking with LOCK_IGNORE_RELAY_BUDGET=1"
  export LOCK_IGNORE_RELAY_BUDGET=1
fi
$W/09-lock-hedera.sh; $W/09-lock-hedera.sh --send
$W/09-lock-hedera.sh --send | tee "$TMP/09-rerun.log"
grep -q 'nothing to do' "$TMP/09-rerun.log" || { echo "rehearse: a re-run of 09 did not see the lock" >&2; exit 1; }
$W/10-lock-arbitrum.sh; $W/10-lock-arbitrum.sh --send
step "final read-back (all locked)"
unset LOCK_IGNORE_RELAY_BUDGET
EXPECT_LOCKED=1 $W/00-readback.sh --record
step "wiring file"
jq -c '{version, contracts, peers, link, feePoolWei, lock: (.lock|keys), steps: [.steps[] | {id, chain, tx: (.tx[0:12])}]}' "$D/$WF"
n=$(jq '.steps | length' "$D/$WF"); echo "$n steps recorded"
echo "rehearsal complete"
