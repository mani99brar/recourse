#!/usr/bin/env bash
# Deploys RecourseCase on Arbitrum Sepolia and records it in deployments/arbitrum.json.
#
#   deploy.sh               dry run: simulates the whole deploy on a fork of the live chain, sends nothing
#   deploy.sh --broadcast   deploys, then fills deployTx and startBlock from the receipt and merges the deploy keys
#                           into deployments/arbitrum.json (the gas and testCases keys are kept as they are)
#   deploy.sh --broadcast --again   allows a second deploy when arbitrum.json already names a case
#   deploy.sh --broadcast --resume  finishes a broadcast that stopped part way (forge --resume: only the
#                           transactions of the last run not yet mined are sent), then records it as above
#   deploy.sh --record-only         sends nothing: records the case the last broadcast created, from
#                           broadcast/DeployRecourseCase.s.sol/421614/run-latest.json, the deploy keys that run wrote
#                           and the receipt; for a deploy that was mined but whose recording step failed
#
# Signing is from the deployer keystore, with the password read from the file next to it. No key or password is
# ever passed on the command line. The deployer becomes the owner.
#
# Env: KEYSTORE_DIR (required, except for --record-only), ARB_RPC_URL, DEPLOYMENTS_DIR (default <repo>/deployments),
# CASE_TEMPLATE_VARIANT, CASE_RELAY_BUDGET.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
CONTRACTS="$ROOT/contracts"
DEPLOY_DIR=${DEPLOYMENTS_DIR:-$ROOT/deployments}
OUT="$DEPLOY_DIR/arbitrum.json"
FRAGMENT="$ROOT/deployments/arbitrum.deploy.local.json"
RUN_FILE="$CONTRACTS/broadcast/DeployRecourseCase.s.sol/421614/run-latest.json"
ARB_RPC=${ARB_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}
ROLE=deployer
export PATH="$HOME/.local/bin:$PATH"

die() { echo "deploy.sh: $*" >&2; exit 1; }

BROADCAST=0; AGAIN=0; RESUME=0; RECORD_ONLY=0
for a in "$@"; do
  case "$a" in
    --broadcast) BROADCAST=1 ;;
    --again) AGAIN=1 ;;
    --resume) RESUME=1 ;;
    --record-only) RECORD_ONLY=1 ;;
    *) die "unknown argument $a" ;;
  esac
done
[ "$RESUME" = 0 ] || [ "$BROADCAST" = 1 ] || die "--resume finishes a broadcast; pass --broadcast with it"
[ "$RECORD_ONLY" = 0 ] || [ "$BROADCAST" = 0 ] || die "--record-only sends nothing; drop --broadcast"

[ "$(cast chain-id --rpc-url "$ARB_RPC")" = "421614" ] || die "ARB_RPC_URL is not Arbitrum Sepolia"
cd "$CONTRACTS"

recorded_case() { [ -f "$OUT" ] && jq -r '.contracts.case.address // empty' "$OUT" || true; }

if [ "$RECORD_ONLY" = 1 ]; then
  [ -f "$RUN_FILE" ] || die "no broadcast to record: $RUN_FILE is missing"
  [ -f "$FRAGMENT" ] || die "no deploy keys to record: $FRAGMENT is missing"
  have=$(recorded_case); want=$(jq -r '.contracts.case.address' "$FRAGMENT")
  if [ -n "$have" ] && [ "$(tr 'A-F' 'a-f' <<<"$have")" != "$(tr 'A-F' 'a-f' <<<"$want")" ] && [ "$AGAIN" = 0 ]; then
    die "$OUT already names another case ($have); pass --again to record $want over it"
  fi
  echo "recording the last broadcast (nothing is sent)"
else
  [ -n "${KEYSTORE_DIR:-}" ] || die "KEYSTORE_DIR is not set"
  KS="$KEYSTORE_DIR/$ROLE.json"
  [ -f "$KS" ] && [ -f "$KS.pass" ] || die "missing keystore or password file for $ROLE"
  SENDER=$(cast wallet address --keystore "$KS" --password-file "$KS.pass")

  if [ "$BROADCAST" = 0 ]; then
    echo "dry run from $SENDER (fork of Arbitrum Sepolia, nothing is sent)"
    forge script script/arbitrum/DeployRecourseCase.s.sol --fork-url "$ARB_RPC" --no-storage-caching \
      --sender "$SENDER"
    echo "deploy keys (dry run):"; jq . "$FRAGMENT"
    exit 0
  fi

  if [ -n "$(recorded_case)" ] && [ "$AGAIN" = 0 ]; then
    die "$OUT already names a case ($(recorded_case)); pass --again to deploy another"
  fi

  resume=(); [ "$RESUME" = 0 ] || resume=(--resume)
  echo "deploying from $SENDER${resume:+ (resuming the last broadcast)}"
  forge script script/arbitrum/DeployRecourseCase.s.sol --rpc-url "$ARB_RPC" \
    --keystore "$KS" --password-file "$KS.pass" --sender "$SENDER" --broadcast --slow "${resume[@]}"
fi

ADDR=$(jq -r '.contracts.case.address' "$FRAGMENT")
TX=$(jq -r --arg a "$ADDR" '[.transactions[] | select(.transactionType == "CREATE" and .contractName == "RecourseCase"
  and ((.contractAddress // "") | ascii_downcase) == ($a | ascii_downcase))][0].hash // empty' "$RUN_FILE")
# A dry run after the broadcast rewrites the deploy keys with the address the next deploy would get.
[ -n "$TX" ] || die "no RecourseCase CREATE for $ADDR in $RUN_FILE (were the deploy keys rewritten by a later dry run?)"
RECEIPT=$(cast receipt "$TX" --rpc-url "$ARB_RPC" --json)
[ "$(jq -r .status <<<"$RECEIPT")" = "0x1" ] || die "deploy transaction $TX failed"
[ "$(jq -r '.contractAddress | ascii_downcase' <<<"$RECEIPT")" = "$(tr 'A-F' 'a-f' <<<"$ADDR")" ] \
  || die "receipt contract address does not match $ADDR"
# The receipt's blockNumber is the Arbitrum block number that eth_getLogs uses (not the L1 number the EVM sees).
BLOCK=$(cast to-dec "$(jq -r .blockNumber <<<"$RECEIPT")")

mkdir -p "$DEPLOY_DIR"
[ -f "$OUT" ] || echo '{}' > "$OUT"
TMP="$OUT.tmp-$$"
jq -s --arg tx "$TX" --argjson block "$BLOCK" '.[0] + (.[1] | .deployTx = $tx | .startBlock = $block)' \
  "$OUT" "$FRAGMENT" > "$TMP"
mv "$TMP" "$OUT"
echo "RecourseCase $ADDR, tx $TX, block $BLOCK; recorded in $OUT"
