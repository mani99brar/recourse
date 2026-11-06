#!/usr/bin/env bash
# Hedera deploy steps for DepositVault and RecourseClaims, in order:
#
#   hedera.sh mock-usdc [--broadcast] [--again]  mock mode only, first: deploy MockUsdc and keep its address (deployer)
#   hedera.sh preflight                       read-only: chain id, deployer HBAR, USDC token, router code, inputs
#   hedera.sh deploy    [--broadcast] [--again]  deploy both, bind, pre-lock config (deployer)
#   hedera.sh associate [--broadcast]         circle: associateUsdc(false), else (true), then the mirror row;
#                                             mock: associateUsdc(true), then usdcAssociated() (deployer)
#   hedera.sh record                          write deployments/$HEDERA_FILE from the broadcast and read-backs
#   hedera.sh wire      [--broadcast]         setPeer(RECOURSE_CASE_ADDRESS) and read-backs (deployer)
#   hedera.sh mint <role|0xaddr> <micro-usdc> [--broadcast] mock mode only: mint mUSDC (deployer, the mock's owner)
#   hedera.sh deposit <micro-usdc> [--broadcast]            platform: USDC approve + postDeposit (platform)
#   hedera.sh required <platform> <micro-usdc> [--broadcast] setRequired (deployer)
#   hedera.sh lock      [--broadcast]         locked params and lockConfig on both, read-backs (deployer)
#   hedera.sh check                           read-only checks plus the mirror association row (mock: the token)
#   hedera.sh rehearse <port>                 every step above on a local anvil, with throwaway keystores (circle)
#
# Without --broadcast a step is a dry run: it simulates or calls and sends nothing. No USDC moves before
# `associate` has seen the vault's token row on the mirror node (mock: usdcAssociated() reads true).
#
# USDC mode, HEDERA_USDC_MODE: circle is Circle's testnet USDC 0.0.429274; mock is MockUsdc ("mUSDC"), a testnet
# stand-in that is not Circle's token. Unset, it is the usdc.mode recorded in $HEDERA_FILE (circle for a file
# without one), else circle. A deployment never mixes them: each USDC step checks the vault's own token against
# the mode, and a step on the recorded deployment refuses any other mode.
#
# Signing is always from a role keystore with its password file next to it ($KEYSTORE_DIR/<role>.json and
# <role>.json.pass); no key or password is ever passed on the command line.
#
# Env: KEYSTORE_DIR (signing steps), HEDERA_RPC_URL_1, HEDERA_MIRROR_URL, POOL_ADDRESS,
# PRECHECK_SIGNER_ADDRESS, RULING_RELAYER_ADDRESS, HEDERA_BRIDGE_MODE (Both, OutOnly or None),
# RECOURSE_CASE_ADDRESS (wire), HEDERA_FILE (default hedera.json), HEDERA_USDC_MODE, USDC_ADDRESS (mock: the
# mock to deploy on, default the one mock-usdc kept; once a mock deployment is recorded, mint takes only its
# vault's token), HEDERA_ASSOC_GAS (default 1000000, mock 150000),
# ETH_GAS_PRICE (mock-usdc and a mock deploy set it to eth_gasPrice + 3% when unset), HEDERA_DEPLOYER_ADDRESS
# (a mock-usdc dry run without KEYSTORE_DIR; default the recorded owner).
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

CIRCLE_USDC=0x0000000000000000000000000000000000068cDa
CIRCLE_USDC_ID=0.0.429274
MOCK_SYMBOL=mUSDC
ROUTER=0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4
PARAMS="$ROOT/packages/shared/vectors/params.json"
PARAM_KEYS='["contestWindow","claimTimeout","courtFeeUsdc","handlingBase","handlingBps","handlingCap","resendGap","maxSends","topUpWindow","exitDelay","minDeposit","gasClaimToCourt","gasRulingBack"]'

die() { echo "hedera.sh: $*" >&2; exit 1; }
log() { echo "hedera.sh: $*"; }

# A deployments file from before the token switch names a claims contract and no usdc object: it is on Circle's.
recorded_mode() {
  [ -f "$OUT" ] || return 0
  jq -r 'if .usdc.mode then .usdc.mode elif .contracts.claims.address then "circle" else empty end' "$OUT"
}
RECORDED_MODE=$(recorded_mode)
USDC_MODE=${HEDERA_USDC_MODE:-${RECORDED_MODE:-circle}}
case "$USDC_MODE" in
  circle) ASSOC_GAS=${HEDERA_ASSOC_GAS:-1000000}; MIN_HBAR=12 ;;
  # The mock is paid for before preflight. Preflight's floor is forge's own balance check for the pair (gas x
  # ETH_GAS_PRICE, about 8.8M gas) plus the association's gas limit at the same price.
  mock) ASSOC_GAS=${HEDERA_ASSOC_GAS:-150000}; PAIR_GAS=8800000 ;;
  *) die "HEDERA_USDC_MODE must be circle or mock, not '$USDC_MODE'" ;;
esac

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

# created <script> <contract>: the address the latest broadcast of <script> created for <contract>.
created() {
  local f="$CONTRACTS/broadcast/$1/$CHAIN_ID/run-latest.json"
  [ -f "$f" ] || die "no $1 broadcast for chain $CHAIN_ID"
  jq -r --arg n "$2" '[.transactions[] | select(.transactionType=="CREATE" and .contractName==$n)][0].contractAddress' "$f"
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

# forge prices EIP-1559 sends at twice the base fee, and the relay checks the balance against gas limit x max fee.
# A set price 3% over eth_gasPrice keeps that headroom small. A price already in the environment is kept.
gas_price() {
  if [ -z "${ETH_GAS_PRICE:-}" ]; then
    ETH_GAS_PRICE=$(python3 -c "print($(cast gas-price --rpc-url "$RPC") * 103 // 100)"); export ETH_GAS_PRICE
  fi
  log "gas price $ETH_GAS_PRICE wei (ETH_GAS_PRICE)"
}

code_bytes() { local c; c=$(cast code "$1" --rpc-url "$RPC"); echo $(( (${#c} - 2) / 2 )); }

# A mock USDC is never Circle's facade, and answers eth_call with code, 6 decimals and the symbol mUSDC.
mock_ok() {
  local t=$1 n dec sym
  [ "${t,,}" != "${CIRCLE_USDC,,}" ] || { log "$t is Circle's USDC, not a mock"; return 1; }
  n=$(code_bytes "$t")
  dec=$(cast call "$t" 'decimals()(uint8)' --rpc-url "$RPC" 2>/dev/null || echo "?")
  sym=$(cast call "$t" 'symbol()(string)' --rpc-url "$RPC" 2>/dev/null || echo "?"); sym=${sym//\"/}
  log "mock USDC $t: $n bytes of code, decimals $dec, symbol $sym"
  [ "$n" -gt 0 ] && [ "$dec" = 6 ] && [ "$sym" = "$MOCK_SYMBOL" ]
}

mock_file() { echo "$(state_dir)/mock-usdc.address"; }

# The deployer (KS) must own the mock, or nothing here can mint it.
mock_owned() {
  local owner; owner=$(cast call "$1" 'owner()(address)' --rpc-url "$RPC")
  [ "${owner,,}" = "$(signer_address | tr 'A-F' 'a-f')" ] || die "the deployer is not the owner ($owner) of mock USDC $1"
}

# The mock to deploy on, or to mint before a mock deployment is recorded: USDC_ADDRESS, else the one mock-usdc
# kept, else the recorded deployment's.
find_mock() {
  local f; f=$(mock_file)
  if [ -n "${USDC_ADDRESS:-}" ]; then echo "$USDC_ADDRESS"
  elif [ -f "$f" ]; then cat "$f"
  elif [ "$RECORDED_MODE" = mock ]; then recorded .usdc.address
  fi
}

# The vault's token. It is immutable, so it is the token every USDC step must use.
vault_token() { cast to-check-sum-address "$(cast call "$1" 'usdc()(address)' --rpc-url "$RPC")"; }

# Prints the vault's token, or stops unless it is the mode's: Circle's facade in circle mode, a mock in mock mode.
token_for_mode() {
  local vault=$1 t; t=$(vault_token "$vault")
  if [ "$USDC_MODE" = circle ]; then
    [ "${t,,}" = "${CIRCLE_USDC,,}" ] || die "vault $vault is on $t, not Circle's USDC; set HEDERA_USDC_MODE=mock"
  else
    mock_ok "$t" >&2 || die "vault $vault is on $t, which is not a mock USDC; set HEDERA_USDC_MODE=circle"
  fi
  echo "$t"
}

# Steps on the recorded deployment refuse a mode other than the recorded one.
same_mode_as_recorded() {
  [ -z "$RECORDED_MODE" ] || [ "$RECORDED_MODE" = "$USDC_MODE" ] \
    || die "HEDERA_USDC_MODE is $USDC_MODE but $OUT records a $RECORDED_MODE deployment"
}

# The recorded deployment's token (Circle's facade for a file without a usdc object); it must be the vault's own.
recorded_token() {
  local vault=$1 t on
  t=$(jq -r --arg c "$CIRCLE_USDC" '.usdc.address // $c' "$OUT")
  on=$(vault_token "$vault")
  [ "${t,,}" = "${on,,}" ] || die "$OUT records USDC $t but vault $vault is on $on"
  echo "$t"
}

# party <role|0xaddr>: an address as given, or the role's evmAddress in deployments/parties.json.
party() {
  if [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; then echo "$1"; return; fi
  local a; a=$(jq -r --arg r "$1" '[.[] | select(.role == $r) | .evmAddress][0] // empty' "$DEPLOY_DIR/parties.json")
  [ -n "$a" ] || die "no role $1 in deployments/parties.json"
  echo "$a"
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
  curl -fsS --max-time 15 "$MIRROR/api/v1/accounts/$1/tokens?token.id=$CIRCLE_USDC_ID" | jq '.tokens | length'
}

assoc_file() { echo "$(state_dir)/association.tx"; }

# The kept association tx, printed only if its receipt succeeded and is a call to <vault>. The file is shared by
# every deployment on the chain, so a hash left from another vault, or from no mined tx, prints nothing.
kept_assoc_tx() {
  local vault=$1 tx f; f=$(assoc_file)
  tx=$([ -f "$f" ] && cat "$f" || true); [ -n "$tx" ] || return 0
  cast receipt "$tx" --async --json --rpc-url "$RPC" 2>/dev/null \
    | jq -r --arg v "${vault,,}" --arg tx "$tx" 'select(.status == "0x1" and ((.to // "") | ascii_downcase) == $v) | $tx' \
    || true
}

BROADCAST=0; AGAIN=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --broadcast) BROADCAST=1 ;;
    --again) AGAIN=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
cmd=${1:-}; shift || true

case "$cmd" in
  mock-usdc)
    require_chain
    [ "$USDC_MODE" = mock ] || die "mock-usdc is for mock mode; set HEDERA_USDC_MODE=mock"
    f=$(mock_file); kept=""
    if [ -f "$f" ]; then kept=$(cat "$f"); elif [ "$RECORDED_MODE" = mock ]; then kept=$(recorded .usdc.address); fi
    if [ -n "$kept" ] && [ "$AGAIN" = 0 ] && [ "$(code_bytes "$kept")" -gt 0 ]; then
      [ "$BROADCAST" = 0 ] || die "a mock USDC already exists at $kept; deploy on it, or pass --again to deploy another"
      log "a mock USDC already exists at $kept; --broadcast would need --again to deploy another"
    fi
    if [ "$BROADCAST" = 1 ] || [ -n "${KEYSTORE_DIR:-}" ]; then
      keystore deployer; flags=("${KS[@]}")
    else
      # A dry run needs no key: it simulates from the deployer's address.
      from=${HEDERA_DEPLOYER_ADDRESS:-$([ -f "$OUT" ] && jq -r '.roles.owner // empty' "$OUT" || true)}
      [ -n "$from" ] || die "a dry run without KEYSTORE_DIR needs HEDERA_DEPLOYER_ADDRESS"
      flags=(--sender "$from"); log "dry run from $from (no keystore)"
    fi
    flags+=(--slow); [ "$BROADCAST" = 1 ] && flags+=(--broadcast)
    gas_price
    forge_script DeployMockUsdc.s.sol "${flags[@]}"
    if [ "$BROADCAST" = 1 ]; then
      token=$(cast to-check-sum-address "$(created DeployMockUsdc.s.sol MockUsdc)")
      mock_ok "$token" || die "the new token at $token does not read back as a mock USDC"
      mock_owned "$token"
      echo "$token" > "$f"
      log "mock USDC $token kept in $f; the deploy evidence is broadcast/DeployMockUsdc.s.sol/$CHAIN_ID"
      log "next: HEDERA_USDC_MODE=mock hedera.sh preflight, then deploy --broadcast (--again to replace $OUT)"
    fi ;;

  preflight)
    require_chain; ok=1
    log "chain id $CHAIN_ID (0x$(printf '%x' "$CHAIN_ID")), USDC mode $USDC_MODE"
    keystore deployer; me=$(signer_address)
    wei=$(cast balance "$me" --rpc-url "$RPC")
    if [ "$USDC_MODE" = mock ]; then
      gas_price
      need=$(python3 -c "print(($PAIR_GAS + $ASSOC_GAS) * $ETH_GAS_PRICE)")
      log "deployer $me holds $(python3 -c "print(f'{$wei / 10**18:.2f}')") HBAR" \
        "(need >= $(python3 -c "print(f'{$need / 10**18:.2f}')"): $PAIR_GAS gas for the pair, $ASSOC_GAS to associate)"
      [ "$(python3 -c "print(int($wei >= $need))")" = 1 ] || ok=0
    else
      hbar=$(python3 -c "print($wei // 10**18)")
      log "deployer $me holds $hbar HBAR (need >= $MIN_HBAR)"; [ "$hbar" -ge "$MIN_HBAR" ] || ok=0
    fi
    if [ "$USDC_MODE" = mock ]; then
      token=$(find_mock)
      if [ -z "$token" ]; then log "no mock USDC yet; run hedera.sh mock-usdc --broadcast"; ok=0
      else mock_ok "$token" || ok=0; fi
    else
      dec=$(curl -fsS --max-time 15 "$MIRROR/api/v1/tokens/$CIRCLE_USDC_ID" | jq -r .decimals || echo "?")
      log "USDC $CIRCLE_USDC_ID on the mirror: decimals $dec"; [ "$dec" = 6 ] || ok=0
    fi
    code=$(cast code "$ROUTER" --rpc-url "$RPC"); [ "${#code}" -gt 2 ] || ok=0
    log "router code: $(( (${#code} - 2) / 2 )) bytes"
    for v in POOL_ADDRESS PRECHECK_SIGNER_ADDRESS RULING_RELAYER_ADDRESS HEDERA_BRIDGE_MODE; do
      [ -n "${!v:-}" ] && log "$v=${!v}" || { log "$v is not set"; ok=0; }
    done
    [ "$ok" = 1 ] && log "preflight OK" || die "preflight FAILED" ;;

  deploy)
    require_chain; keystore deployer
    if [ "$BROADCAST" = 1 ] && [ -f "$OUT" ] && [ "$AGAIN" = 0 ] && [ "${HEDERA_REDEPLOY:-0}" != 1 ]; then
      die "$OUT exists (claims $(jq -r '.contracts.claims.address // "none"' "$OUT")); pass --again (or set HEDERA_REDEPLOY=1) to deploy another pair"
    fi
    if [ "$USDC_MODE" = mock ]; then
      USDC_ADDRESS=$(find_mock)
      [ -n "$USDC_ADDRESS" ] || die "no mock USDC; run hedera.sh mock-usdc --broadcast first, or set USDC_ADDRESS"
      mock_ok "$USDC_ADDRESS" || die "$USDC_ADDRESS is not a mock USDC"
      mock_owned "$USDC_ADDRESS"
      export USDC_ADDRESS
      gas_price
    elif [ -z "${HEDERA_USDC_MODE:-}" ] && [ -f "$(mock_file)" ]; then
      die "a mock USDC is kept at $(cat "$(mock_file)"); set HEDERA_USDC_MODE=mock to deploy on it, or =circle for Circle's USDC"
    fi
    export HEDERA_USDC_MODE=$USDC_MODE
    flags=("${KS[@]}" --slow); [ "$BROADCAST" = 1 ] && flags+=(--broadcast)
    forge_script Deploy.s.sol "${flags[@]}"
    if [ "$BROADCAST" = 1 ]; then
      # The kept association tx is the previous vault's; the new one gets its own at associate.
      rm -f "$(assoc_file)"
      log "vault $(deployed DepositVault), claims $(deployed RecourseClaims)"
      log "next: hedera.sh associate --broadcast"
    fi ;;

  associate)
    require_chain; vault=$(deployed DepositVault)
    token=$(token_for_mode "$vault")
    marked=$(cast call "$vault" 'usdcAssociated()(bool)' --rpc-url "$RPC")
    [ "$marked" = true ] && log "vault already marked associated"
    # A mock is not an HTS token, so the HTS path cannot succeed on it and is not tried.
    paths="false true"; fail="both association paths failed"
    [ "$USDC_MODE" = mock ] && { paths=true; fail="associateUsdc(true) failed"; }
    kept=""; [ "$USDC_MODE" = mock ] && [ "$marked" = true ] && kept=$(kept_assoc_tx "$vault")
    if [ -n "$kept" ]; then
      # On the mock the vault's flag is all a second call would set, so nothing is sent.
      log "associateUsdc already ok for this vault: $kept (kept in $(assoc_file)); nothing sent"
    elif [ "$BROADCAST" = 1 ]; then
      [ "$USDC_MODE" = mock ] && [ "$marked" = true ] \
        && log "no association tx of this vault is kept, so one is sent for the record"
      keystore deployer
      tx=""
      for via in $paths; do
        r=$(cast send "$vault" "associateUsdc(bool)" "$via" --gas-limit "$ASSOC_GAS" --rpc-url "$RPC" "${KS[@]}" --json || true)
        if [ "$(echo "$r" | jq -r '.status // empty' 2>/dev/null)" = 0x1 ]; then tx=$(echo "$r" | jq -r .transactionHash); break; fi
        log "associateUsdc($via) did not succeed: $(echo "$r" | jq -r '.transactionHash // "no receipt"' 2>/dev/null)"
      done
      [ -n "$tx" ] || die "$fail; stop all USDC steps"
      echo "$tx" > "$(assoc_file)"
      log "associateUsdc ok: $tx"
    else
      send deployer "$vault" "associateUsdc(bool)" "${paths%% *}"
    fi
    if [ "$USDC_MODE" = mock ]; then
      # No mirror token row exists for a non-HTS token; the vault's own flag is the read-back.
      if [ "$BROADCAST" = 1 ] || [ -n "$kept" ]; then
        [ "$(cast call "$vault" 'usdcAssociated()(bool)' --rpc-url "$RPC")" = true ] \
          || die "vault $vault does not read usdcAssociated() true; do not move mUSDC"
        log "vault $vault reads usdcAssociated() true on mock USDC $token; USDC steps may proceed"
      fi
    elif [ "$REHEARSAL" = 1 ]; then
      [ "$(cast call "$token" 'isAssociated()(bool)' --from "$vault" --rpc-url "$RPC")" = true ] \
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
    token=$(token_for_mode "$vault")
    assoc=$(kept_assoc_tx "$vault")
    [ -n "$assoc" ] || die "no successful association tx to vault $vault is kept in $(assoc_file); run associate --broadcast first"
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
    if [ "$USDC_MODE" = mock ]; then
      dec=$(cast call "$token" 'decimals()(uint8)' --rpc-url "$RPC")
      usdc=$(jq -n --arg a "$token" --argjson d "$dec" '{mode: "mock", address: $a, decimals: $d, tokenId: null}')
    else
      usdc=$(jq -n --arg a "$token" --arg id "$CIRCLE_USDC_ID" '{mode: "circle", address: $a, decimals: 6, tokenId: $id}')
    fi
    prev='{}'
    if [ -f "$OUT" ] && [ "$(jq -r '.contracts.vault.address' "$OUT")" = "$vault" ]; then prev=$(cat "$OUT"); fi
    mkdir -p "$DEPLOY_DIR"
    tmp=$(mktemp "$DEPLOY_DIR/.hedera.XXXXXX")
    jq -n --argjson chainId "$CHAIN_ID" --arg claims "$claims" --arg vault "$vault" \
      --argjson cid "$cid" --argjson vid "$vid" --arg start "$start" --argjson block "$block" \
      --arg assoc "$assoc" --argjson mode "$mode" --arg extra "$extra" \
      --argjson csize "$csize" --argjson vsize "$vsize" \
      --arg owner "$owner" --arg relayer "$relayer" --arg signer "$signer" --arg pool "$pool" \
      --argjson usdc "$usdc" --argjson keys "$PARAM_KEYS" --slurpfile params "$PARAMS" --argjson prev "$prev" '
      ($params[0]) as $p
      | {
          chainId: $chainId,
          contracts: { claims: { address: $claims, id: $cid }, vault: { address: $vault, id: $vid } },
          usdc: $usdc,
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
    require_chain; same_mode_as_recorded; keystore deployer
    [ -n "${RECOURSE_CASE_ADDRESS:-}" ] || die "RECOURSE_CASE_ADDRESS is not set"
    flags=("${KS[@]}" --slow); [ "$BROADCAST" = 1 ] && flags+=(--broadcast)
    RECOURSE_CASE_ADDRESS="$RECOURSE_CASE_ADDRESS" forge_script Wire.s.sol "${flags[@]}" ;;

  mint)
    require_chain; who=${1:-}; amount=${2:-}
    [ "$USDC_MODE" = mock ] || die "mint is for the mock USDC only; set HEDERA_USDC_MODE=mock"
    [ -n "$who" ] && [[ "$amount" =~ ^[0-9]+$ ]] || die "mint needs <role|0xaddr> <micro-usdc>"
    to=$(party "$who")
    # Once a mock deployment is recorded, mint only its vault's token, the one deposit and claims pull.
    if [ "$RECORDED_MODE" = mock ]; then
      token=$(recorded_token "$(recorded .contracts.vault.address)")
      [ -z "${USDC_ADDRESS:-}" ] || [ "${USDC_ADDRESS,,}" = "${token,,}" ] \
        || die "USDC_ADDRESS $USDC_ADDRESS is not the recorded vault's token $token"
    else
      token=$(find_mock); [ -n "$token" ] || die "no mock USDC; run hedera.sh mock-usdc --broadcast first"
    fi
    mock_ok "$token" || die "$token is not a mock USDC"
    keystore deployer; mock_owned "$token"
    send deployer "$token" "mint(address,uint256)" "$to" "$amount"
    log "$MOCK_SYMBOL balance of $who ($to): $(cast call "$token" 'balanceOf(address)(uint256)' "$to" --rpc-url "$RPC")" ;;

  deposit)
    require_chain; same_mode_as_recorded; amount=${1:-}; [ -n "$amount" ] || die "deposit needs an amount in micro-USDC"
    vault=$(recorded .contracts.vault.address)
    token=$(recorded_token "$vault")
    [ "$(cast call "$vault" 'usdcAssociated()(bool)' --rpc-url "$RPC")" = true ] || die "vault is not associated"
    keystore platform; platform=$(signer_address)
    send platform "$token" "approve(address,uint256)(bool)" "$vault" "$amount"
    # A dry run's approve is a call and leaves no allowance, and postDeposit pulls through one.
    allowed=""
    [ "$BROADCAST" = 1 ] \
      || allowed=$(cast call "$token" 'allowance(address,address)(uint256)' "$platform" "$vault" --rpc-url "$RPC" | awk '{print $1}')
    if [ -n "$allowed" ] && [[ "$amount" =~ ^[0-9]+$ ]] && [ "$(python3 -c "print(int($allowed < $amount))")" = 1 ]; then
      log "dry run: postDeposit not simulated, as the vault's allowance stays $allowed until the approve is sent"
    else
      send platform "$vault" "postDeposit(address,uint256)" "$platform" "$amount"
    fi
    if [ "$BROADCAST" = 1 ]; then
      tmp=$(mktemp "$DEPLOY_DIR/.hedera.XXXXXX")
      jq --arg tx "$LAST_TX" '.dpTx.dp2 = $tx' "$OUT" > "$tmp" && chmod 644 "$tmp" && mv "$tmp" "$OUT"
      log "deposit of platform $platform: $(cast call "$vault" 'depositOf(address)(uint256)' "$platform" --rpc-url "$RPC")"
    fi ;;

  required)
    require_chain; same_mode_as_recorded; platform=${1:-}; amount=${2:-}
    [ -n "$platform" ] && [ -n "$amount" ] || die "required needs <platform> <micro-usdc>"
    vault=$(recorded .contracts.vault.address)
    send deployer "$vault" "setRequired(address,uint256)" "$platform" "$amount"
    log "inGoodStanding($platform) = $(cast call "$vault" 'inGoodStanding(address)(bool)' "$platform" --rpc-url "$RPC")" ;;

  lock)
    require_chain; same_mode_as_recorded; keystore deployer
    flags=("${KS[@]}" --slow); [ "$BROADCAST" = 1 ] && flags+=(--broadcast)
    forge_script Lock.s.sol "${flags[@]}" ;;

  check)
    require_chain; same_mode_as_recorded
    forge_script Check.s.sol
    vault=$(recorded .contracts.vault.address)
    if [ "$USDC_MODE" = mock ]; then
      # A mock has no mirror token row; the vault's token must be the recorded mock and read back as one.
      token=$(recorded_token "$vault")
      mock_ok "$token" && log "OK   mock USDC: the vault's token is the recorded $MOCK_SYMBOL" \
        || die "FAIL mock USDC: $token does not read back as $MOCK_SYMBOL with 6 decimals"
    elif [ "$REHEARSAL" = 1 ]; then
      log "rehearsal: no mirror node; association checked on chain only"
    else
      rows=$(mirror_token_rows "$vault")
      [ "$rows" = 1 ] && log "OK   mirror: one USDC row for the vault" || die "FAIL mirror: $rows USDC rows for the vault"
    fi ;;

  rehearse)
    port=${1:-}; [ -n "$port" ] || die "rehearse needs the port of a running anvil"
    # The rehearsal runs in circle mode, on the HTS USDC test double at Circle's facade address.
    [ "${HEDERA_USDC_MODE:-circle}" = circle ] || die "rehearse runs in circle mode only"
    export HEDERA_USDC_MODE=circle
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
    usdc=$(jq -r .usdc.address "$DEPLOY_DIR/$HEDERA_FILE")
    keystore platform
    cast send "$usdc" "associate()" --rpc-url "$RPC" "${KS[@]}" >/dev/null
    cast send "$usdc" "mint(address,uint256)" "$platform" 10000000000 --rpc-url "$RPC" --unlocked \
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

  *) sed -n '2,36p' "$0"; exit 1 ;;
esac
