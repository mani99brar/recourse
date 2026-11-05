#!/usr/bin/env bash
# Step 1. Hedera: RecourseClaims.setPeer(<RecourseCase on Arbitrum>). Signs as the deployer (the owner).
# Needs both deployments files. Only possible before the Claims config is locked.
# Read-back: Claims.peer() equals the RecourseCase address.
# Usage: 01-peer-hedera.sh [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed

[ "$(hcall "$CLAIMS" 'configLocked()(bool)')" = false ] || die "Claims config is locked; setPeer is no longer possible"
expect "Claims owner" "$(hcall "$CLAIMS" 'owner()(address)')" "$(role_address deployer)"
cur=$(hcall "$CLAIMS" 'peer()(address)')
if [ "$(lower "$cur")" = "$(lower "$CASE")" ]; then
  log "Claims.peer() already equals the RecourseCase; nothing to send"
else
  log "Claims.peer() is $cur; will set $CASE"
  tx hedera deployer "$CLAIMS" 'setPeer(address)' "$CASE"
  if [ "$SEND" = 1 ]; then
    expect "Claims.peer()" "$(hcall "$CLAIMS" 'peer()(address)')" "$CASE"
    wiring_step W3-claims-peer hedera "setPeer($CASE)" deployer "$LAST_TX" "peer = $CASE"
  fi
fi
wiring_update --arg p "$CASE" --arg sel "$(hcall "$CLAIMS" 'arbSelector()(uint64)' | first)" \
  '.peers.casePeer = $p | .peers.arbSelector = $sel'
