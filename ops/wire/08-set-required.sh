#!/usr/bin/env bash
# Step 8. Hedera: DepositVault.setRequired(platform, amount) through hedera.sh required. Signs as the deployer
# (the owner). It stays available after the lock. The amount comes from what actually arrived as USDC.
# Usage: 08-set-required.sh <micro-usdc> [--send]
# Read-back: requiredOf(platform) equals the amount and inGoodStanding(platform) is true. Nothing may be ordered
# before this reads true.
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
amount=${ARGS[0]:-}; [[ "$amount" =~ ^[0-9]+$ ]] || die "usage: 08-set-required.sh <micro-usdc> [--send]"
HSH=$ROOT/contracts/script/hedera/hedera.sh
platform=$(role_address platform)
expect "Vault owner" "$(hcall "$VAULT" 'owner()(address)')" "$(role_address deployer)"
export HEDERA_FILE HEDERA_RPC_URL_1=$HEDERA_RPC HEDERA_MIRROR_URL=$MIRROR HEDERA_REHEARSAL=$WIRE_LOCAL
if [ "$SEND" = 0 ]; then
  "$HSH" required "$platform" "$amount"; exit 0
fi
out=$("$HSH" required "$platform" "$amount" --broadcast) || { echo "$out"; die "hedera.sh required failed"; }
echo "$out"
txid=$(grep -o 'setRequired(address,uint256) ok: 0x[0-9a-fA-F]*' <<<"$out" | tail -1 | awk '{print $3}')
[ -n "$txid" ] || die "could not find the setRequired tx in the output"
expect "requiredOf(platform)" "$(hcall "$VAULT" 'requiredOf(address)(uint256)' "$platform" | first)" "$amount"
expect "inGoodStanding(platform)" "$(hcall "$VAULT" 'inGoodStanding(address)(bool)' "$platform")" true
wiring_step W8-set-required hedera "setRequired($platform, $amount)" deployer "$txid" "inGoodStanding = true"
