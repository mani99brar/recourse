#!/usr/bin/env bash
# Deploys RecourseCase on Arbitrum Sepolia and records it in deployments/arbitrum.json.
#
#   deploy.sh               dry run: simulates the whole deploy on a fork of the live chain, sends nothing
#   deploy.sh --broadcast   deploys, then fills deployTx and startBlock from the receipt and merges the deploy keys
#                           into deployments/arbitrum.json (the gas and testCases keys are kept as they are)
#   deploy.sh --broadcast --again   allows a second deploy when arbitrum.json already names a case
#
# Signing is from the deployer keystore, with the password read from the file next to it. No key or password is
# ever passed on the command line. The deployer becomes the owner.
#
# Env: KEYSTORE_DIR (required), ARB_RPC_URL, DEPLOYMENTS_DIR (default <repo>/deployments), CASE_TEMPLATE_VARIANT.
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

BROADCAST=0; AGAIN=0
for a in "$@"; do
  case "$a" in
    --broadcast) BROADCAST=1 ;;
    --again) AGAIN=1 ;;
    *) die "unknown argument $a" ;;
  esac
done

[ -n "${KEYSTORE_DIR:-}" ] || die "KEYSTORE_DIR is not set"
KS="$KEYSTORE_DIR/$ROLE.json"
[ -f "$KS" ] && [ -f "$KS.pass" ] || die "missing keystore or password file for $ROLE"
SENDER=$(cast wallet address --keystore "$KS" --password-file "$KS.pass")
[ "$(cast chain-id --rpc-url "$ARB_RPC")" = "421614" ] || die "ARB_RPC_URL is not Arbitrum Sepolia"

cd "$CONTRACTS"
if [ "$BROADCAST" = 0 ]; then
  echo "dry run from $SENDER (fork of Arbitrum Sepolia, nothing is sent)"
  forge script script/arbitrum/DeployRecourseCase.s.sol --fork-url "$ARB_RPC" --no-storage-caching \
    --sender "$SENDER"
  echo "deploy keys (dry run):"; jq . "$FRAGMENT"
  exit 0
fi

if [ -f "$OUT" ] && [ "$(jq -r '.contracts.case.address // empty' "$OUT")" != "" ] && [ "$AGAIN" = 0 ]; then
  die "$OUT already names a case ($(jq -r '.contracts.case.address' "$OUT")); pass --again to deploy another"
fi

echo "deploying from $SENDER"
forge script script/arbitrum/DeployRecourseCase.s.sol --rpc-url "$ARB_RPC" \
  --keystore "$KS" --password-file "$KS.pass" --sender "$SENDER" --broadcast --slow

ADDR=$(jq -r '.contracts.case.address' "$FRAGMENT")
TX=$(jq -r --arg a "$ADDR" '[.transactions[] | select(.transactionType == "CREATE" and .contractName == "RecourseCase"
  and ((.contractAddress // "") | ascii_downcase) == ($a | ascii_downcase))][0].hash // empty' "$RUN_FILE")
[ -n "$TX" ] || die "no RecourseCase CREATE for $ADDR in $RUN_FILE"
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
