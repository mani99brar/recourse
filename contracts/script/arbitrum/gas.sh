#!/usr/bin/env bash
# Measures RecourseCase gas on a read-only fork of Arbitrum Sepolia and records it in deployments/arbitrum.json
# under `gas` (only that key is rewritten).
#
#   gas.sh            run the fork test at the current Arbitrum block, print the numbers, record them
#   gas.sh --print    run and print only
#
# Nothing is sent to the network: the fork is local to forge. Each entry is {used, limit}, limit = used + 25%.
# `forkBlock` is the Arbitrum block number (the one eth_getLogs and explorers use) the fork was pinned to.
#
# Env: ARB_RPC_URL, DEPLOYMENTS_DIR (default <repo>/deployments).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
CONTRACTS="$ROOT/contracts"
DEPLOY_DIR=${DEPLOYMENTS_DIR:-$ROOT/deployments}
OUT="$DEPLOY_DIR/arbitrum.json"
FRAGMENT_NAME=arbitrum-gas.local.json
FRAGMENT="$ROOT/deployments/$FRAGMENT_NAME"
ARB_RPC=${ARB_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}
export PATH="$HOME/.local/bin:$PATH"

die() { echo "gas.sh: $*" >&2; exit 1; }
PRINT_ONLY=0
[ "${1:-}" = "--print" ] && PRINT_ONLY=1

[ "$(cast chain-id --rpc-url "$ARB_RPC")" = "421614" ] || die "ARB_RPC_URL is not Arbitrum Sepolia"
BLOCK=$(cast block-number --rpc-url "$ARB_RPC")
rm -f "$FRAGMENT"

cd "$CONTRACTS"
CASE_GAS_OUT=$FRAGMENT_NAME forge test --jobs 1 --match-path 'test/arbitrum/RecourseCaseFork.t.sol' \
  --fork-url "$ARB_RPC" --fork-block-number "$BLOCK" -vv
[ -f "$FRAGMENT" ] || die "the fork test wrote no gas file"
jq . "$FRAGMENT"
[ "$PRINT_ONLY" = 1 ] && exit 0

mkdir -p "$DEPLOY_DIR"
[ -f "$OUT" ] || echo '{}' > "$OUT"
TMP="$OUT.tmp-$$"
jq -s --argjson block "$BLOCK" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.[0] + {gas: ({measuredAt: $at, forkBlock: $block} + .[1])}' "$OUT" "$FRAGMENT" > "$TMP"
mv "$TMP" "$OUT"
echo "gas recorded in $OUT (fork block $BLOCK)"
