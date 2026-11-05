#!/usr/bin/env bash
# Optional step, only when the team takes the no-CCIP claim path for the court side: RecourseCase.setTrustedRelay
# (<ops-arb address>) from the deployer, before the lock. It lets that one address submit claims without CCIP,
# a disclosed trusted step. Pass --clear to set it back to the zero address.
# Read-back: trustedRelay() equals the address.
# Usage: 11-trusted-relay.sh [--clear] [--send]
. "$(dirname "$0")/lib.sh"
clear=0; rest=(); for a in "$@"; do [ "$a" = --clear ] && clear=1 || rest+=("$a"); done
parse_args "${rest[@]+"${rest[@]}"}"; check_chains both; load_deployed
[ "$(acall "$CASE" 'locked()(bool)')" = false ] || die "RecourseCase is locked"
want=$(role_address ops-arb); [ "$clear" = 1 ] && want=0x0000000000000000000000000000000000000000
tx arbitrum deployer "$CASE" 'setTrustedRelay(address)' "$want"
if [ "$SEND" = 1 ]; then
  expect "trustedRelay()" "$(acall "$CASE" 'trustedRelay()(address)')" "$want"
  wiring_step W3a-trusted-relay arbitrum "setTrustedRelay($want)" deployer "$LAST_TX" "trustedRelay = $want"
fi
