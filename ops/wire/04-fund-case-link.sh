#!/usr/bin/env bash
# Step 4. Arbitrum Sepolia: LINK for RecourseCase, which pays the CCIP fee of every ruling it sends back.
# Signs as ops-arb (FUND_ROLE to change). Tops up to the target; a re-run sends nothing.
#   CASE_LINK_TARGET   LINK to hold, in whole LINK (default 1 before the lock; use 5 at the lock)
# Read-back: Case LINK balance equals the target or more.
# Usage: 04-fund-case-link.sh [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
ROLE=${FUND_ROLE:-ops-arb}
expect "Case.link()" "$(acall "$CASE" 'link()(address)')" "$ALINK"
target=$(python3 -c "from decimal import Decimal as D; print(int(D('${CASE_LINK_TARGET:-1}')*10**18))")
have=$(acall "$ALINK" 'balanceOf(address)(uint256)' "$CASE" | first)
log "RecourseCase holds $have wei of LINK, target $target"
need=$(python3 -c "print(max(0, $target - $have))")
if [ "$need" = 0 ]; then
  log "already at target; nothing to send"
else
  tx arbitrum "$ROLE" "$ALINK" 'transfer(address,uint256)(bool)' "$CASE" "$need"
  if [ "$SEND" = 1 ]; then
    got=$(acall "$ALINK" 'balanceOf(address)(uint256)' "$CASE" | first)
    [ "$(python3 -c "print(int($got >= $target))")" = 1 ] || die "read-back: Case holds $got LINK wei, wanted $target"
    log "ok   Case LINK = $got"
    wiring_step W5-case-link arbitrum "LINK transfer $need" "$ROLE" "$LAST_TX" "balance $got"
  fi
fi
wiring_update --arg v "$(acall "$ALINK" 'balanceOf(address)(uint256)' "$CASE" | first)" '.link.case = $v'
