#!/usr/bin/env bash
# Step 3. Hedera: give RecourseClaims what it needs to pay for CCIP sends to the court.
# The fee token is read from Claims.feeToken(): LINK (nonzero) is topped up by a LINK transfer, native (zero)
# by fundNative(). Signs as ops-hedera (FUND_ROLE to change). Top-up semantics: it sends only the shortfall to
# the target, so a re-run sends nothing.
#   CLAIMS_LINK_TARGET     LINK to hold, in whole LINK (default 1 before the lock; use 5 at the lock)
#   CLAIMS_HBAR_TARGET     HBAR to hold in native mode (default 5)
# Read-back: the balance after equals the target (or more).
# Usage: 03-fund-claims.sh [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
ROLE=${FUND_ROLE:-ops-hedera}
ft=$(hcall "$CLAIMS" 'feeToken()(address)')
zero=0x0000000000000000000000000000000000000000
if [ "$(lower "$ft")" = "$zero" ]; then
  # Native mode. The contract counts tinybars (10^8 per HBAR); JSON-RPC value and cast balance use weibars (10^18).
  target=$(python3 -c "from decimal import Decimal as D; print(int(D('${CLAIMS_HBAR_TARGET:-5}')*10**18))")
  have=$(cast balance "$CLAIMS" --rpc-url "$HEDERA_RPC")
  log "native mode: Claims holds $have weibar, target $target"
  need=$(python3 -c "print(max(0, $target - $have))")
  if [ "$need" = 0 ]; then
    log "already at target; nothing to send"
  else
    tx hedera "$ROLE" "$CLAIMS" 'fundNative()' --value "$need"
    if [ "$SEND" = 1 ]; then
      got=$(cast balance "$CLAIMS" --rpc-url "$HEDERA_RPC")
      [ "$(python3 -c "print(int($got >= $target))")" = 1 ] || die "read-back: Claims holds $got weibar, wanted $target"
      log "ok   Claims balance = $got weibar"
      wiring_step W5-claims-native hedera "fundNative() value $need" "$ROLE" "$LAST_TX" "balance $got weibar"
    fi
  fi
else
  expect "Claims.link()" "$(hcall "$CLAIMS" 'link()(address)')" "$ft"
  target=$(python3 -c "from decimal import Decimal as D; print(int(D('${CLAIMS_LINK_TARGET:-1}')*10**18))")
  have=$(hcall "$ft" 'balanceOf(address)(uint256)' "$CLAIMS" | first)
  log "LINK mode: Claims holds $have wei of LINK, target $target"
  need=$(python3 -c "print(max(0, $target - $have))")
  if [ "$need" = 0 ]; then
    log "already at target; nothing to send"
  else
    tx hedera "$ROLE" "$ft" 'transfer(address,uint256)(bool)' "$CLAIMS" "$need"
    if [ "$SEND" = 1 ]; then
      got=$(hcall "$ft" 'balanceOf(address)(uint256)' "$CLAIMS" | first)
      [ "$(python3 -c "print(int($got >= $target))")" = 1 ] || die "read-back: Claims holds $got LINK wei, wanted $target"
      log "ok   Claims LINK = $got"
      wiring_step W5-claims-link hedera "LINK transfer $need" "$ROLE" "$LAST_TX" "balance $got"
    fi
  fi
  wiring_update --arg v "$(hcall "$ft" 'balanceOf(address)(uint256)' "$CLAIMS" | first)" '.link.claims = $v'
fi
