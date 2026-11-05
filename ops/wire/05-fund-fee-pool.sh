#!/usr/bin/env bash
# Step 5. Arbitrum Sepolia: the RecourseCase fee pool, the ETH that pays Kleros arbitration costs.
# fundFeePool() is payable and open to anyone; this signs as ops-arb (FUND_ROLE to change). Tops up to the target.
#   FEE_POOL_TARGET_ETH   pool to hold, in ETH (default 0.01 before the lock; 0.02 at the lock)
# Read-back: feePool() equals the target or more, and the contract's ETH balance covers it.
# Usage: 05-fund-fee-pool.sh [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
ROLE=${FUND_ROLE:-ops-arb}
target=$(python3 -c "from decimal import Decimal as D; print(int(D('${FEE_POOL_TARGET_ETH:-0.01}')*10**18))")
have=$(acall "$CASE" 'feePool()(uint256)' | first)
cost=$(acall "$CASE" 'costNow()(uint256)' | first)
log "fee pool holds $have wei, target $target; live arbitration cost $cost wei (about $(python3 -c "print($target // max($cost,1))") cases)"
need=$(python3 -c "print(max(0, $target - $have))")
if [ "$need" = 0 ]; then
  log "already at target; nothing to send"
else
  tx arbitrum "$ROLE" "$CASE" 'fundFeePool()' --value "$need"
  if [ "$SEND" = 1 ]; then
    got=$(acall "$CASE" 'feePool()(uint256)' | first)
    [ "$(python3 -c "print(int($got >= $target))")" = 1 ] || die "read-back: feePool() is $got, wanted $target"
    bal=$(cast balance "$CASE" --rpc-url "$ARB_RPC")
    [ "$(python3 -c "print(int($bal >= $got))")" = 1 ] || die "read-back: contract balance $bal is below feePool() $got"
    log "ok   feePool() = $got, balance = $bal"
    wiring_step W6-fee-pool arbitrum "fundFeePool() value $need" "$ROLE" "$LAST_TX" "feePool $got"
  fi
fi
wiring_update --argjson v "$(acall "$CASE" 'feePool()(uint256)' | first)" '.feePoolWei = ($v | tostring)'
