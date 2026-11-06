#!/usr/bin/env bash
# Step 7. Hedera: the platform's USDC deposit into DepositVault (approve, then postDeposit), through
# contracts/script/hedera/hedera.sh deposit. Signs as the platform. Moves USDC, so it refuses to run until the
# vault shows the USDC association. The USDC is the vault's token as $HEDERA_FILE records it: Circle's, or the
# testnet mock mUSDC.
# Usage: 07-deposit.sh <micro-usdc> [--send]      (1 USDC = 1000000)
# Dry run: checks the preconditions (association, platform USDC and HBAR) and prints the plan; it cannot
# simulate postDeposit before the approve exists, so it sends and simulates nothing.
# Read-back: depositOf(platform) rose by the amount.
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
amount=${ARGS[0]:-}; [[ "$amount" =~ ^[0-9]+$ ]] || die "usage: 07-deposit.sh <micro-usdc> [--send]"
HSH=$ROOT/contracts/script/hedera/hedera.sh
USDC=$VAULT_USDC
expect "Vault.usdc() is the recorded $VAULT_USDC_LABEL" "$(hcall "$VAULT" 'usdc()(address)')" "$USDC"
[ "$(hcall "$VAULT" 'usdcAssociated()(bool)')" = true ] || die "vault is not marked USDC-associated; run the associate step first"
platform=$(role_address platform)
usdc=$(hcall "$USDC" 'balanceOf(address)(uint256)' "$platform" | first)
log "platform $platform holds $usdc micro-$VAULT_USDC_SYMBOL ($VAULT_USDC_LABEL); deposit $amount"
[ "$(python3 -c "print(int($usdc >= $amount))")" = 1 ] || die "platform $VAULT_USDC_SYMBOL balance is below the amount"
before=$(hcall "$VAULT" 'depositOf(address)(uint256)' "$platform" | first)
if [ "$SEND" = 0 ]; then
  log "dry run: would run 'hedera.sh deposit $amount --broadcast' as platform (approve, then postDeposit)"; exit 0
fi
out=$(HEDERA_FILE=$HEDERA_FILE HEDERA_RPC_URL_1=$HEDERA_RPC HEDERA_MIRROR_URL=$MIRROR HEDERA_REHEARSAL=$WIRE_LOCAL \
  "$HSH" deposit "$amount" --broadcast) || { echo "$out"; die "hedera.sh deposit failed"; }
echo "$out"
txid=$(grep -o 'postDeposit(address,uint256) ok: 0x[0-9a-fA-F]*' <<<"$out" | tail -1 | awk '{print $3}')
[ -n "$txid" ] || die "could not find the postDeposit tx in the output"
after=$(hcall "$VAULT" 'depositOf(address)(uint256)' "$platform" | first)
[ "$(python3 -c "print(int($after == $before + $amount))")" = 1 ] || die "read-back: deposit is $after, wanted $((before + amount))"
log "ok   depositOf(platform) = $after"
wiring_step W8-deposit hedera "approve + postDeposit($platform, $amount)" platform "$txid" "depositOf = $after"
