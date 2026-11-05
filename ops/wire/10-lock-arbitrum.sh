#!/usr/bin/env bash
# Step 10. Arbitrum Sepolia: final parameters (only if they differ) and lockConfig on RecourseCase. Signs as the
# deployer. ONE WAY. After it setPeer, setParams, setTrustedRelay and sweepLink are gone; setExtraArgs,
# setPolicyURI, setTemplateText and withdrawFeePool remain.
# The locked parameter set is the "locked" block of packages/shared/vectors/params.json (caseDeadline,
# maxOpenCases, resendGap, maxSends), unless CASE_PARAMS="deadline,cap,gap,sends" is given.
# Refuses to lock while the peer is unset or the template or policy is not set.
# Read-back: locked() is true and params() equals the intended set.
# Usage: 10-lock-arbitrum.sh [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
[ "$(acall "$CASE" 'locked()(bool)')" = false ] || die "RecourseCase is already locked"
expect "RecourseCase owner" "$(acall "$CASE" 'owner()(address)')" "$(role_address deployer)"
expect "RecourseCase.peer()" "$(acall "$CASE" 'peer()(address)')" "$CLAIMS"
if [ -n "${CASE_PARAMS:-}" ]; then IFS=, read -r dl cap gap sends <<<"$CASE_PARAMS"
else
  read -r dl cap gap sends < <(jq -r '.locked | "\(.caseDeadline) \(.maxOpenCases) \(.resendGap) \(.maxSends)"' "$PARAMS_JSON")
fi
want="($dl, $cap, $gap, $sends)"
curv=$(acall "$CASE" 'params()(uint64,uint16,uint64,uint8)' | first | paste -sd, | sed 's/,/, /g')
log "params now ($curv), intended $want"
if [ "($curv)" != "$want" ]; then
  tx arbitrum deployer "$CASE" 'setParams(uint64,uint16,uint64,uint8)' "$dl" "$cap" "$gap" "$sends"
  [ "$SEND" = 1 ] && wiring_step L-case-params arbitrum "setParams$want" deployer "$LAST_TX" "params $want"
fi
tx arbitrum deployer "$CASE" 'lockConfig()'
if [ "$SEND" = 1 ]; then
  expect "RecourseCase.locked()" "$(acall "$CASE" 'locked()(bool)')" true
  got=$(acall "$CASE" 'params()(uint64,uint16,uint64,uint8)' | first | paste -sd, | sed 's/,/, /g')
  expect "RecourseCase.params()" "($got)" "$want"
  wiring_step L-lock-case arbitrum "lockConfig()" deployer "$LAST_TX" "locked = true"
  wiring_update --arg tx "$LAST_TX" --arg at "$(date -u +%FT%TZ)" '.lock.case = {tx:$tx, at:$at}'
fi
