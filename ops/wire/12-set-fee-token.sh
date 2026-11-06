#!/usr/bin/env bash
# Step 3.3a (when the ops keys hold no Hedera LINK). Choose how RecourseClaims pays CCIP fees to the court:
# native HBAR (feeToken zero, funded by 03-fund-claims.sh through fundNative) or LINK. setFeeToken stays
# available after the lock, so this can be switched back later. Signs as the deployer (the owner).
# A Hedera to Arbitrum send quoted 2.20 HBAR native or 0.013 LINK on 6 Nov.
# Read-back: Claims.feeToken() equals zero (native) or the Hedera LINK address.
# Usage: 12-set-fee-token.sh <native|link> [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains hedera; load_deployed
mode=${ARGS[0]:-}
case "$mode" in
  native) want=0x0000000000000000000000000000000000000000 ;;
  link) want=$HLINK ;;
  *) die "usage: 12-set-fee-token.sh <native|link> [--send]" ;;
esac
cur=$(hcall "$CLAIMS" 'feeToken()(address)')
if [ "$(lower "$cur")" = "$(lower "$want")" ]; then
  log "ok   Claims.feeToken() = $cur ($mode)"; exit 0
fi
log "Claims.feeToken() is $cur; will set $want ($mode)"
tx hedera deployer "$CLAIMS" 'setFeeToken(address)' "$want"
if [ "$SEND" = 1 ]; then
  expect "Claims.feeToken()" "$(hcall "$CLAIMS" 'feeToken()(address)')" "$want"
  wiring_step W3a-claims-fee-token hedera "setFeeToken($want)" deployer "$LAST_TX" "feeToken = $want ($mode)"
fi
