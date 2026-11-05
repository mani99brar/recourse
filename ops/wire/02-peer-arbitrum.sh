#!/usr/bin/env bash
# Step 2. Arbitrum Sepolia: RecourseCase.setPeer(<RecourseClaims on Hedera>). Signs as the deployer (the owner).
# Only possible before the RecourseCase config is locked.
# Read-back: RecourseCase.peer() equals the Claims address.
# Usage: 02-peer-arbitrum.sh [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed

[ "$(acall "$CASE" 'locked()(bool)')" = false ] || die "RecourseCase config is locked; setPeer is no longer possible"
expect "RecourseCase owner" "$(acall "$CASE" 'owner()(address)')" "$(role_address deployer)"
cur=$(acall "$CASE" 'peer()(address)')
if [ "$(lower "$cur")" = "$(lower "$CLAIMS")" ]; then
  log "RecourseCase.peer() already equals Claims; nothing to send"
else
  log "RecourseCase.peer() is $cur; will set $CLAIMS"
  tx arbitrum deployer "$CASE" 'setPeer(address)' "$CLAIMS"
  if [ "$SEND" = 1 ]; then
    expect "RecourseCase.peer()" "$(acall "$CASE" 'peer()(address)')" "$CLAIMS"
    wiring_step W3-case-peer arbitrum "setPeer($CLAIMS)" deployer "$LAST_TX" "peer = $CLAIMS"
  fi
fi
wiring_update --arg p "$CLAIMS" --arg sel "$(acall "$CASE" 'hederaSelector()(uint64)' | first)" \
  '.peers.claimsPeer = $p | .peers.hederaSelector = $sel'
