#!/usr/bin/env bash
# CCIP ping between Arbitrum Sepolia and Hedera testnet, contract to contract.
#
#   ping.sh deploy <arbitrum|hedera> [--broadcast]       deploy RecoursePing, record it in deployments/ping.json
#   ping.sh peer   <arbitrum|hedera> [--broadcast]       point that chain's ping at the other chain's ping
#   ping.sh fund   <arbitrum|hedera> <LINK> [--broadcast] move LINK from the chain's ops key to its ping
#   ping.sh send   <arbitrum|hedera> [--native] [--broadcast]   send one ping from that chain to the other
#   ping.sh status                                       read each recorded send on the destination OffRamp
#
# Without --broadcast every command is a dry run: it simulates against the live chain and sends nothing.
# Signing is always from the role keystore: ops-arb on Arbitrum, ops-hedera on Hedera, with the password read from
# the file next to it. No key or password is ever passed on the command line.
#
# Env: KEYSTORE_DIR (required), ARB_RPC_URL, HEDERA_RPC_URL_1, DEPLOYMENTS_DIR (default <repo>/deployments).
# Order for a first run: arbitrum -> hedera first (400k receive gas), then hedera -> arbitrum (300k).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
CONTRACTS="$ROOT/contracts"
DEPLOY_DIR=${DEPLOYMENTS_DIR:-$ROOT/deployments}
OUT="$DEPLOY_DIR/ping.json"
export PATH="$HOME/.local/bin:$PATH"

ARB_RPC=${ARB_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}
HED_RPC=${HEDERA_RPC_URL_1:-https://testnet.hashio.io/api}

die() { echo "ping.sh: $*" >&2; exit 1; }

chain_conf() {
  case "$1" in
    arbitrum)
      CHAIN=arbitrum; OTHER=hedera; RPC=$ARB_RPC; CHAIN_ID=421614; ROLE=ops-arb
      SELECTOR=3478487238524512106; OTHER_SELECTOR=222782988166878823
      ROUTER=0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165; LINK=0xb1D4538B4571d411F07960EF2838Ce337FE1E80E
      OFFRAMP=0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA   # receives from Hedera
      SEND_GAS=400000; NATIVE_SCALE=1 ;;
    hedera)
      CHAIN=hedera; OTHER=arbitrum; RPC=$HED_RPC; CHAIN_ID=296; ROLE=ops-hedera
      SELECTOR=222782988166878823; OTHER_SELECTOR=3478487238524512106
      ROUTER=0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4; LINK=0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6
      OFFRAMP=0x7752798D2fD9e28b7020135A619dDD162d705f20   # receives from Arbitrum
      # Inside the EVM Hedera counts value in tinybars; a JSON-RPC transaction value is in weibars (x 10^10).
      SEND_GAS=300000; NATIVE_SCALE=10000000000 ;;
    *) die "chain must be arbitrum or hedera" ;;
  esac
}

keystore_args() {
  [ -n "${KEYSTORE_DIR:-}" ] || die "KEYSTORE_DIR is not set"
  local ks="$KEYSTORE_DIR/$ROLE.json"
  [ -f "$ks" ] && [ -f "$ks.pass" ] || die "missing keystore or password file for $ROLE"
  KS=(--keystore "$ks" --password-file "$ks.pass")
}

signer_address() { cast wallet address "${KS[@]}"; }

ensure_out() {
  mkdir -p "$DEPLOY_DIR"
  [ -f "$OUT" ] || echo '{"sends":[]}' > "$OUT"
}

# jq_update <filter> [jq args...]: rewrite ping.json through a temp file in the same directory.
jq_update() {
  local filter=$1; shift
  local tmp; tmp=$(mktemp "$DEPLOY_DIR/.ping.XXXXXX")
  jq "$@" "$filter" "$OUT" > "$tmp" && mv "$tmp" "$OUT"
}

ping_addr() { jq -r --arg c "$1" '.[$c].address // empty' "$OUT" 2>/dev/null; }

BROADCAST=0; NATIVE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --broadcast) BROADCAST=1 ;;
    --native) NATIVE=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]}"
cmd=${1:-}; shift || true

case "$cmd" in
  deploy)
    chain_conf "${1:-}"; keystore_args; ensure_out
    [ -z "$(ping_addr "$CHAIN")" ] || [ "${PING_REDEPLOY:-0}" = 1 ] \
      || die "$CHAIN ping already recorded; set PING_REDEPLOY=1 to deploy another"
    flags=(--rpc-url "$RPC" "${KS[@]}" --slow)
    [ "$BROADCAST" = 1 ] && flags+=(--broadcast)
    (cd "$CONTRACTS" && forge script script/ping/DeployPing.s.sol "${flags[@]}")
    if [ "$BROADCAST" = 1 ]; then
      run="$CONTRACTS/broadcast/DeployPing.s.sol/$CHAIN_ID/run-latest.json"
      addr=$(jq -r '.transactions[0].contractAddress' "$run")
      tx=$(jq -r '.transactions[0].hash' "$run")
      blk=$(( $(jq -r '.receipts[0].blockNumber' "$run") ))
      owner=$(signer_address)
      jq_update '.[$c] = {chainId: ($id|tonumber), selector: $sel, address: $a, owner: $o, router: $r, link: $l,
                          offRamp: $off, deployTx: $tx, deployBlock: ($b|tonumber)}' \
        --arg c "$CHAIN" --arg id "$CHAIN_ID" --arg sel "$SELECTOR" --arg a "$addr" --arg o "$owner" \
        --arg r "$ROUTER" --arg l "$LINK" --arg off "$OFFRAMP" --arg tx "$tx" --arg b "$blk"
      echo "recorded $CHAIN ping $addr in $OUT"
    fi ;;

  peer)
    chain_conf "${1:-}"; keystore_args
    me=$(ping_addr "$CHAIN"); peer=$(ping_addr "$OTHER")
    [ -n "$me" ] && [ -n "$peer" ] || die "deploy both pings first"
    if [ "$BROADCAST" = 1 ]; then
      cast send "$me" "setPeer(uint64,address)" "$OTHER_SELECTOR" "$peer" --rpc-url "$RPC" "${KS[@]}"
    else
      cast call "$me" "setPeer(uint64,address)" "$OTHER_SELECTOR" "$peer" --from "$(signer_address)" --rpc-url "$RPC" \
        && echo "dry run ok: setPeer($OTHER_SELECTOR, $peer) on $CHAIN"
    fi
    echo "peerOf($OTHER_SELECTOR) = $(cast call "$me" "peerOf(uint64)(address)" "$OTHER_SELECTOR" --rpc-url "$RPC")" ;;

  fund)
    chain_conf "${1:-}"; keystore_args
    amount=${2:-}; [ -n "$amount" ] || die "fund needs an amount of LINK, e.g. 1"
    me=$(ping_addr "$CHAIN"); [ -n "$me" ] || die "deploy the $CHAIN ping first"
    wei=$(cast to-wei "$amount" ether)
    if [ "$BROADCAST" = 1 ]; then
      cast send "$LINK" "transfer(address,uint256)(bool)" "$me" "$wei" --rpc-url "$RPC" "${KS[@]}"
    else
      cast call "$LINK" "transfer(address,uint256)(bool)" "$me" "$wei" --from "$(signer_address)" --rpc-url "$RPC" \
        && echo "dry run ok: transfer $amount LINK to $me"
    fi
    echo "ping LINK balance: $(cast call "$LINK" "balanceOf(address)(uint256)" "$me" --rpc-url "$RPC")" ;;

  send)
    chain_conf "${1:-}"; keystore_args; ensure_out
    me=$(ping_addr "$CHAIN"); [ -n "$me" ] || die "deploy the $CHAIN ping first"
    now=$(date -u +%s)
    nonce=$(jq '.sends | length' "$OUT")
    data=$(cast abi-encode "f(uint8,bytes32,uint256,uint256,uint256)" 1 "$(cast keccak recourse.ping)" "$now" "$nonce" "$CHAIN_ID")
    gas=${PING_GAS:-$SEND_GAS}
    if [ "$NATIVE" = 1 ]; then
      fee=$(cast call "$me" "quoteNative(uint64,bytes,uint256)(uint256)" "$OTHER_SELECTOR" "$data" "$gas" --rpc-url "$RPC" | awk '{print $1}')
      # 10% headroom for a fee move between quote and inclusion; the contract refunds whatever it does not use.
      value=$(python3 -c "print($fee * 11 // 10 * $NATIVE_SCALE)")
      sig="sendNative(uint64,bytes,uint256)(bytes32)"; val=(--value "$value"); token=native
    else
      fee=$(cast call "$me" "quote(uint64,bytes,uint256)(uint256)" "$OTHER_SELECTOR" "$data" "$gas" --rpc-url "$RPC" | awk '{print $1}')
      sig="send(uint64,bytes,uint256)(bytes32)"; val=(); token=LINK
    fi
    echo "fee quote ($token, contract units): $fee"
    if [ "$BROADCAST" != 1 ]; then
      cast call "$me" "$sig" "$OTHER_SELECTOR" "$data" "$gas" "${val[@]}" --from "$(signer_address)" --rpc-url "$RPC" \
        && echo "dry run ok: $CHAIN -> $OTHER at gas $gas"
      exit 0
    fi
    receipt=$(cast send "$me" "$sig" "$OTHER_SELECTOR" "$data" "$gas" "${val[@]}" --rpc-url "$RPC" "${KS[@]}" --json)
    topic=$(cast keccak "PingSent(bytes32,uint64,address,uint256,address,uint256,bytes32)")
    msgid=$(echo "$receipt" | jq -r --arg t "$topic" --arg a "${me,,}" \
      '.logs[] | select((.address|ascii_downcase)==$a and .topics[0]==$t) | .topics[1]' | head -1)
    tx=$(echo "$receipt" | jq -r '.transactionHash')
    status=$(echo "$receipt" | jq -r '.status')
    [ -n "$msgid" ] || die "no PingSent event in $tx (status $status)"
    jq_update '.sends += [{from: $f, to: $t, messageId: $m, tx: $tx, sentAt: $at, gasLimit: ($g|tonumber),
                          feeToken: $tok, fee: $fee, executionState: null, received: false, checkedAt: null}]' \
      --arg f "$CHAIN" --arg t "$OTHER" --arg m "$msgid" --arg tx "$tx" \
      --arg at "$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)" --arg g "$gas" --arg tok "$token" --arg fee "$fee"
    echo "sent $CHAIN -> $OTHER messageId $msgid tx $tx"
    echo "explorer: https://ccip.chain.link/msg/$msgid" ;;

  status)
    [ -f "$OUT" ] || die "no $OUT yet"
    n=$(jq '.sends | length' "$OUT")
    for ((i = 0; i < n; i++)); do
      to=$(jq -r ".sends[$i].to" "$OUT"); msgid=$(jq -r ".sends[$i].messageId" "$OUT")
      chain_conf "$to"
      dest=$(ping_addr "$to")
      state=$(cast call "$OFFRAMP" "getExecutionState(bytes32)(uint8)" "$msgid" --rpc-url "$RPC" 2>/dev/null || echo "")
      got=false
      if [ -n "$dest" ]; then
        # receivedOf returns (sourceSelector, sender, ...); a zero sender means nothing was stored.
        sender=$(cast call "$dest" "receivedOf(bytes32)((uint64,address,uint32,uint32,bytes32,bytes32[5]))" "$msgid" \
          --rpc-url "$RPC" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' | head -1 || true)
        [ -n "$sender" ] && [ "$sender" != 0x0000000000000000000000000000000000000000 ] && got=true
      fi
      api=$(curl -fsS --max-time 15 "https://api.ccip.chain.link/v2/messages/$msgid" 2>/dev/null \
        | jq -c 'with_entries(select(.value|type!="object" and type!="array"))' 2>/dev/null || echo null)
      jq_update ".sends[$i].executionState = (\$s|if .==\"\" then null else tonumber end)
                 | .sends[$i].received = (\$r==\"true\") | .sends[$i].checkedAt = \$at | .sends[$i].ccipApi = \$api" \
        --arg s "$state" --arg r "$got" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson api "${api:-null}"
      echo "$msgid ${CHAIN}: executionState=${state:-?} (0 untouched, 1 in progress, 2 success, 3 failure) received=$got"
    done ;;

  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
