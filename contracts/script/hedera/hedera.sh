#!/usr/bin/env bash
# Hedera deploy steps for DepositVault and RecourseClaims, in order:
#
#   hedera.sh preflight                       read-only: chain id, deployer HBAR, USDC token, router code, inputs
#   hedera.sh deploy    [--broadcast]         deploy both, bind, pre-lock config (deployer)
#   hedera.sh associate [--broadcast]         associateUsdc(false), else (true); then the mirror row (deployer)
#   hedera.sh record                          write deployments/$HEDERA_FILE from the broadcast and read-backs
#   hedera.sh wire      [--broadcast]         setPeer(RECOURSE_CASE_ADDRESS) and read-backs (deployer)
#   hedera.sh deposit <micro-usdc> [--broadcast]            platform: USDC approve + postDeposit (platform)
#   hedera.sh required <platform> <micro-usdc> [--broadcast] setRequired (deployer)
#   hedera.sh lock      [--broadcast]         locked params and lockConfig on both, read-backs (deployer)
#   hedera.sh check                           read-only checks plus the mirror association row
#   hedera.sh rehearse <port>                 every step above on a local anvil, with throwaway keystores
#
# Without --broadcast a step is a dry run: it simulates or calls and sends nothing. No USDC moves before
# `associate` has seen the vault's token row on the mirror node.
#
# Signing is always from a role keystore with its password file next to it ($KEYSTORE_DIR/<role>.json and
# <role>.json.pass); no key or password is ever passed on the command line.
#
# Env: KEYSTORE_DIR (signing steps), HEDERA_RPC_URL_1, HEDERA_MIRROR_URL, POOL_ADDRESS,
# PRECHECK_SIGNER_ADDRESS, RULING_RELAYER_ADDRESS, HEDERA_BRIDGE_MODE (Both, OutOnly or None),
# RECOURSE_CASE_ADDRESS (wire), HEDERA_FILE (default hedera.json), HEDERA_ASSOC_GAS (default 1000000).
# The deployments file is always <repo>/deployments/$HEDERA_FILE (the forge scripts can read only there).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
CONTRACTS="$ROOT/contracts"
DEPLOY_DIR="$ROOT/deployments"
export PATH="$HOME/.local/bin:$PATH"

RPC=${HEDERA_RPC_URL_1:-https://testnet.hashio.io/api}
MIRROR=${HEDERA_MIRROR_URL:-https://testnet.mirrornode.hedera.com}
HEDERA_FILE=${HEDERA_FILE:-hedera.json}
OUT="$DEPLOY_DIR/$HEDERA_FILE"
REHEARSAL=${HEDERA_REHEARSAL:-0}
ASSOC_GAS=${HEDERA_ASSOC_GAS:-1000000}

USDC=0x0000000000000000000000000000000000068cDa
USDC_ID=0.0.429274
ROUTER=0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4
MIN_HBAR=30
PARAMS="$ROOT/packages/shared/vectors/params.json"
PARAM_KEYS='["contestWindow","claimTimeout","courtFeeUsdc","handlingBase","handlingBps","handlingCap","resendGap","maxSends","topUpWindow","exitDelay","minDeposit","gasClaimToCourt","gasRulingBack"]'

die() { echo "hedera.sh: $*" >&2; exit 1; }
log() { echo "hedera.sh: $*"; }

chain_id() { cast chain-id --rpc-url "$RPC"; }

require_chain() {
  local id; id=$(chain_id)
  if [ "$REHEARSAL" = 1 ]; then
    [ "$id" != 295 ] && [ "$id" != 296 ] || die "rehearsal refuses Hedera chain $id"
  else
    [ "$id" = 296 ] || die "chain id is $id, not Hedera testnet (296 = 0x128)"
  fi
  CHAIN_ID=$id
}

keystore() {
  [ -n "${KEYSTORE_DIR:-}" ] || die "KEYSTORE_DIR is not set"
  local ks="$KEYSTORE_DIR/$1.json"
  [ -f "$ks" ] && [ -f "$ks.pass" ] || die "missing keystore or password file for $1"
  KS=(--keystore "$ks" --password-file "$ks.pass")
}

signer_address() { cast wallet address "${KS[@]}"; }

run_latest() { echo "$CONTRACTS/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"; }

deployed() {
  local f; f=$(run_latest)
  [ -f "$f" ] || die "no Deploy broadcast for chain $CHAIN_ID; run deploy --broadcast first"
  jq -r --arg n "$1" '[.transactions[] | select(.transactionType=="CREATE" and .contractName==$n)][0].contractAddress' "$f"
}

recorded() { jq -r "$1" "$OUT"; }

state_dir() {
  local d=${HEDERA_STATE_DIR:-$HOME/.local/state/recourse/hedera-$CHAIN_ID}
  mkdir -p "$d"; echo "$d"
}

forge_script() {
  local script=$1; shift
  (cd "$CONTRACTS" && HEDERA_FILE="$HEDERA_FILE" forge script "script/hedera/$script" --rpc-url "$RPC" "$@")
}

# send <role> <to> <sig> [args...]: cast send with the role keystore when broadcasting, else cast call from it.
send() {
  local role=$1 to=$2 sig=$3; shift 3
  keystore "$role"
  if [ "$BROADCAST" = 1 ]; then
    local r; r=$(cast send "$to" "$sig" "$@" --rpc-url "$RPC" "${KS[@]}" --json)
    [ "$(echo "$r" | jq -r .status)" = 0x1 ] || die "$sig failed: $(echo "$r" | jq -r .transactionHash)"
    LAST_TX=$(echo "$r" | jq -r .transactionHash)
    log "$sig ok: $LAST_TX"
  else
    cast call "$to" "$sig" "$@" --from "$(signer_address)" --rpc-url "$RPC" >/dev/null
    log "dry run ok: $sig"
  fi
}

mirror_token_rows() {
  curl -fsS --max-time 15 "$MIRROR/api/v1/accounts/$1/tokens?token.id=$USDC_ID" | jq '.tokens | length'
}

BROADCAST=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --broadcast) BROADCAST=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
cmd=${1:-}; shift || true

case "$cmd" in
  preflight)
    require_chain; ok=1
    log "chain id $CHAIN_ID (0x$(printf '%x' "$CHAIN_ID"))"
    keystore deployer; me=$(signer_address)
    wei=$(cast balance "$me" --rpc-url "$RPC")
    hbar=$(python3 -c "print($wei // 10**18)")
    log "deployer $me holds $hbar HBAR (need >= $MIN_HBAR)"; [ "$hbar" -ge "$MIN_HBAR" ] || ok=0
    dec=$(curl -fsS --max-time 15 "$MIRROR/api/v1/tokens/$USDC_ID" | jq -r .decimals || echo "?")
    log "USDC $USDC_ID on the mirror: decimals $dec"; [ "$dec" = 6 ] || ok=0
    code=$(cast code "$ROUTER" --rpc-url "$RPC"); [ "${#code}" -gt 2 ] || ok=0
    log "router code: $(( (${#code} - 2) / 2 )) bytes"
    for v in POOL_ADDRESS PRECHECK_SIGNER_ADDRESS RULING_RELAYER_ADDRESS HEDERA_BRIDGE_MODE; do
      [ -n "${!v:-}" ] && log "$v=${!v}" || { log "$v is not set"; ok=0; }
    done
    [ "$ok" = 1 ] && log "preflight OK" || die "preflight FAILED" ;;

  deploy)
    require_chain; keystore deployer
    if [ "$BROADCAST" = 1 ] && [ -f "$OUT" ] && [ "${HEDERA_REDEPLOY:-0}" != 1 ]; then
      die "$OUT exists; set HEDERA_REDEPLOY=1 to deploy another pair"
    fi
    flags=("${KS[@]}" --slow); [ "$BROADCAST" = 1 ] && flags+=(--broadcast)
    forge_script Deploy.s.sol "${flags[@]}"
    if [ "$BROADCAST" = 1 ]; then
      log "vault $(deployed DepositVault), claims $(deployed RecourseClaims)"
      log "next: hedera.sh associate --broadcast"
    fi ;;

  associate)
    require_chain; vault=$(deployed DepositVault)
    [ "$(cast call "$vault" 'usdcAssociated()(bool)' --rpc-url "$RPC")" = true ] && log "vault already marked associated"
    if [ "$BROADCAST" = 1 ]; then
      keystore deployer
      tx=""
      for via in false true; do
        r=$(cast send "$vault" "associateUsdc(bool)" "$via" --gas-limit "$ASSOC_GAS" --rpc-url "$RPC" "${KS[@]}" --json || true)
        if [ "$(echo "$r" | jq -r '.status // empty' 2>/dev/null)" = 0x1 ]; then tx=$(echo "$r" | jq -r .transactionHash); break; fi
        log "associateUsdc($via) did not succeed: $(echo "$r" | jq -r '.transactionHash // "no receipt"' 2>/dev/null)"
      done
      [ -n "$tx" ] || die "both association paths failed; stop all USDC steps"
      echo "$tx" > "$(state_dir)/association.tx"
      log "associateUsdc ok: $tx"
    else
      send deployer "$vault" "associateUsdc(bool)" false
    fi
    if [ "$REHEARSAL" = 1 ]; then
      [ "$(cast call "$USDC" 'isAssociated()(bool)' --from "$vault" --rpc-url "$RPC")" = true ] \
        || die "mock token does not show the vault associated"
      log "rehearsal: mock token shows the vault associated (no mirror locally)"
    elif [ "$BROADCAST" = 1 ]; then
      rows=0
      for _ in $(seq 1 24); do
        rows=$(mirror_token_rows "$vault" || echo 0); [ "$rows" = 1 ] && break; sleep 5
      done
      [ "$rows" = 1 ] || die "mirror shows $rows USDC rows for the vault after 2 minutes; do not move USDC"
      log "mirror: vault $vault holds the USDC association row; USDC steps may proceed"
    fi ;;

  record)
    require_chain; f=$(run_latest)
    vault=$(cast to-check-sum-address "$(deployed DepositVault)")
    claims=$(cast to-check-sum-address "$(deployed RecourseClaims)")
    assoc_file="$(state_dir)/association.tx"
    assoc=$([ -f "$assoc_file" ] && cat "$assoc_file" || echo "")
    [ -n "$assoc" ] || die "no association recorded; run associate --broadcast first"
    [ "$(cast call "$vault" 'usdcAssociated()(bool)' --rpc-url "$RPC")" = true ] || die "vault is not associated"
    block=$(jq -r --arg a "${vault,,}" '[.receipts[] | select((.contractAddress // "" | ascii_downcase) == $a)][0].blockNumber' "$f")
    block=$(( block ))
    if [ "$REHEARSAL" = 1 ]; then
      vid=null; cid=null
      start="$(cast block "$block" --field timestamp --rpc-url "$RPC").000000000"
    else
      vid=$(curl -fsS --max-time 15 "$MIRROR/api/v1/contracts/$vault" | jq '.contract_id')
      cid=$(curl -fsS --max-time 15 "$MIRROR/api/v1/contracts/$claims" | jq '.contract_id')
      start=$(curl -fsS --max-time 15 "$MIRROR/api/v1/contracts/$vault" | jq -r '.created_timestamp')
      [ "$vid" != null ] && [ "$cid" != null ] && [ -n "$start" ] || die "mirror has not indexed both contracts yet; retry"
    fi
    mode=$(cast call "$claims" 'bridgeMode()(uint8)' --rpc-url "$RPC")
    extra=$(cast call "$claims" 'extraArgs()(bytes)' --rpc-url "$RPC")
    csize=$(cast codesize "$claims" --rpc-url "$RPC"); vsize=$(cast codesize "$vault" --rpc-url "$RPC")
    owner=$(cast call "$claims" 'owner()(address)' --rpc-url "$RPC")
    relayer=$(cast call "$claims" 'rulingRelayer()(address)' --rpc-url "$RPC")
    signer=$(cast call "$claims" 'preCheckSigner()(address)' --rpc-url "$RPC")
    pool=$(cast call "$vault" 'pool()(address)' --rpc-url "$RPC")
    prev='{}'
    if [ -f "$OUT" ] && [ "$(jq -r '.contracts.vault.address' "$OUT")" = "$vault" ]; then prev=$(cat "$OUT"); fi
    mkdir -p "$DEPLOY_DIR"
    tmp=$(mktemp "$DEPLOY_DIR/.hedera.XXXXXX")
    jq -n --argjson chainId "$CHAIN_ID" --arg claims "$claims" --arg vault "$vault" \
      --argjson cid "$cid" --argjson vid "$vid" --arg start "$start" --argjson block "$block" \
      --arg assoc "$assoc" --argjson mode "$mode" --arg extra "$extra" \
      --argjson csize "$csize" --argjson vsize "$vsize" \
      --arg owner "$owner" --arg relayer "$relayer" --arg signer "$signer" --arg pool "$pool" \
      --argjson keys "$PARAM_KEYS" --slurpfile params "$PARAMS" --argjson prev "$prev" '
      ($params[0]) as $p
      | {
          chainId: $chainId,
          contracts: { claims: { address: $claims, id: $cid }, vault: { address: $vault, id: $vid } },
          deployOrder: ["DepositVault", "RecourseClaims"],
          startTimestamp: $start,
          startBlock: $block,
          associationTx: $assoc,
          mode: $mode,
          batch: false,
          params: { preLock: ($p.preLock | with_entries(select(.key as $k | $keys | index($k)))),
                    locked:  ($p.locked  | with_entries(select(.key as $k | $keys | index($k)))) },
          extraArgs: $extra,
          sizes: { RecourseClaims: $csize, DepositVault: $vsize },
          gas: ($prev.gas // {}),
          dpTx: (($prev.dpTx // {}) + { dp1: $assoc }),
          sourcify: ($prev.sourcify // null),
          roles: { owner: $owner, rulingRelayer: $relayer, preCheckSigner: $signer, pool: $pool }
        }' > "$tmp"
    if [ "$REHEARSAL" = 1 ]; then
      # Local-only keys so the anvil proofs can run on the rehearsal file.
      base="$DEPLOY_DIR/${REHEARSAL_BASE_FILE:?}"
      jq --slurpfile b "$base" --arg platform "${REHEARSAL_PLATFORM:?}" --arg shop "${REHEARSAL_SHOP:?}" \
        '.local = $b[0].local | .roles.platform = $platform | .roles.shop = $shop
         | .note = "anvil rehearsal of the testnet steps with test mocks; never a testnet deployment"' "$tmp" > "$tmp.2"
      mv "$tmp.2" "$tmp"
    fi
    chmod 644 "$tmp"; mv "$tmp" "$OUT"
    log "wrote $OUT"
    [ "$REHEARSAL" = 1 ] || log "commit it together with contracts/broadcast/*/$CHAIN_ID/ (deploy evidence)" ;;

  wire)
    require_chain; keystore deployer
    [ -n "${RECOURSE_CASE_ADDRESS:-}" ] || die "RECOURSE_CASE_ADDRESS is not set"
    flags=("${KS[@]}" --slow); [ "$BROADCAST" = 1 ] && flags+=(--broadcast)
    RECOURSE_CASE_ADDRESS="$RECOURSE_CASE_ADDRESS" forge_script Wire.s.sol "${flags[@]}" ;;

  deposit)
    require_chain; amount=${1:-}; [ -n "$amount" ] || die "deposit needs an amount in micro-USDC"
    vault=$(recorded .contracts.vault.address)
    [ "$(cast call "$vault" 'usdcAssociated()(bool)' --rpc-url "$RPC")" = true ] || die "vault is not associated"
    keystore platform; platform=$(signer_address)
    send platform "$USDC" "approve(address,uint256)(bool)" "$vault" "$amount"
    send platform "$vault" "postDeposit(address,uint256)" "$platform" "$amount"
    if [ "$BROADCAST" = 1 ]; then
      tmp=$(mktemp "$DEPLOY_DIR/.hedera.XXXXXX")
      jq --arg tx "$LAST_TX" '.dpTx.dp2 = $tx' "$OUT" > "$tmp" && chmod 644 "$tmp" && mv "$tmp" "$OUT"
      log "deposit of platform $platform: $(cast call "$vault" 'depositOf(address)(uint256)' "$platform" --rpc-url "$RPC")"
    fi ;;

  required)
    require_chain; platform=${1:-}; amount=${2:-}
    [ -n "$platform" ] && [ -n "$amount" ] || die "required needs <platform> <micro-usdc>"
    vault=$(recorded .contracts.vault.address)
    send deployer "$vault" "setRequired(address,uint256)" "$platform" "$amount"
    log "inGoodStanding($platform) = $(cast call "$vault" 'inGoodStanding(address)(bool)' "$platform" --rpc-url "$RPC")" ;;

  lock)
    require_chain; keystore deployer
    flags=("${KS[@]}" --slow); [ "$BROADCAST" = 1 ] && flags+=(--broadcast)
    forge_script Lock.s.sol "${flags[@]}" ;;

  check)
    require_chain
    forge_script Check.s.sol
    vault=$(recorded .contracts.vault.address)
    if [ "$REHEARSAL" = 1 ]; then
      log "rehearsal: no mirror node; association checked on chain only"
    else
      rows=$(mirror_token_rows "$vault")
      [ "$rows" = 1 ] && log "OK   mirror: one USDC row for the vault" || die "FAIL mirror: $rows USDC rows for the vault"
    fi ;;

  rehearse)
    port=${1:-}; [ -n "$port" ] || die "rehearse needs the port of a running anvil"
    export HEDERA_RPC_URL_1="http://127.0.0.1:$port" HEDERA_REHEARSAL=1
    RPC=$HEDERA_RPC_URL_1; REHEARSAL=1; require_chain
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    # Throwaway keystores, made here and deleted on exit; the password goes through the environment.
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$tmp/pass"
    for role in deployer platform; do
      CAST_PASSWORD=$(cat "$tmp/pass") cast wallet new "$tmp" "$role.json" >/dev/null
      cp "$tmp/pass" "$tmp/$role.json.pass"
    done
    export KEYSTORE_DIR=$tmp HEDERA_STATE_DIR=$tmp/state
    deployer=$(cast wallet address --keystore "$tmp/deployer.json" --password-file "$tmp/deployer.json.pass")
    platform=$(cast wallet address --keystore "$tmp/platform.json" --password-file "$tmp/platform.json.pass")
    for a in "$deployer" "$platform"; do cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null; done

    # Mocks, local router and LINK (the stack DeployLocal also deploys is not used here).
    base=hedera.rehearsal-base.local.json
    (cd "$CONTRACTS" && HEDERA_LOCAL_FILE=$base forge script script/hedera/DeployLocal.s.sol --rpc-url "$RPC" \
      --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 >/dev/null)
    export HEDERA_ROUTER=$(jq -r .local.router "$DEPLOY_DIR/$base") HEDERA_LINK=$(jq -r .local.link "$DEPLOY_DIR/$base")
    export POOL_ADDRESS=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc            # anvil 5
    export PRECHECK_SIGNER_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC # anvil 2
    export RULING_RELAYER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8  # anvil 1
    export RECOURSE_CASE_ADDRESS=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720   # anvil 9, a plain address
    export HEDERA_BRIDGE_MODE=${HEDERA_BRIDGE_MODE:-Both}
    export HEDERA_FILE=hedera.rehearsal.local.json REHEARSAL_BASE_FILE=$base
    export REHEARSAL_PLATFORM=$platform REHEARSAL_SHOP=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 # shop: anvil 4
    rm -f "$DEPLOY_DIR/$HEDERA_FILE"
    self=("$0")

    "${self[@]}" deploy --broadcast
    "${self[@]}" associate --broadcast
    "${self[@]}" record
    "${self[@]}" wire --broadcast
    "${self[@]}" check

    # Mock-only setup: the platform's token association and test USDC.
    keystore platform
    cast send "$USDC" "associate()" --rpc-url "$RPC" "${KS[@]}" >/dev/null
    cast send "$USDC" "mint(address,uint256)" "$platform" 10000000000 --rpc-url "$RPC" --unlocked \
      --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 >/dev/null
    "${self[@]}" deposit 5000000000 --broadcast
    "${self[@]}" required "$platform" 5000000000 --broadcast

    # The claim proofs sign as the platform too, so anvil accepts its address unlocked from here on.
    cast rpc anvil_impersonateAccount "$platform" --rpc-url "$RPC" >/dev/null
    tag=$(date +%s)
    proofs() {
      (cd "$CONTRACTS" && HEDERA_LOCAL_FILE=$HEDERA_FILE forge script script/hedera/Proofs.s.sol \
        --sig "run(uint8,uint256)" "$1" "$tag" --rpc-url "$RPC" --broadcast --unlocked \
        --sender "$RULING_RELAYER_ADDRESS" >/dev/null)
    }
    proofs 1
    cast rpc evm_increaseTime 601 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null
    proofs 2
    log "rehearsal: proofs passed"

    "${self[@]}" lock --broadcast
    CHECK_EXPECT_LOCKED=1 "${self[@]}" check
    log "rehearsal complete: $DEPLOY_DIR/$HEDERA_FILE" ;;

  *) sed -n '2,24p' "$0"; exit 1 ;;
esac
