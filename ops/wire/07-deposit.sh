#!/usr/bin/env bash
# Step 7. Hedera: the platform's USDC deposit into DepositVault (approve, then postDeposit), through
# contracts/script/hedera/hedera.sh deposit. Signs as the platform. Moves USDC, so it refuses to run until the
# vault shows the USDC association. The USDC is the vault's token as $HEDERA_FILE records it: Circle's, or the
# testnet mock mUSDC.
# Usage: 07-deposit.sh <target-micro-usdc> [--send]      (1 USDC = 1000000)
# Top-up semantics, as steps 03 to 05: the argument is the deposit the platform should hold, and only the
# shortfall below it is deposited. A re-run after a step that died late (after postDeposit was mined) sends
# nothing, so a deposit is never made twice.
# Dry run: checks the preconditions (association, platform USDC and HBAR) and prints the plan; it cannot
# simulate postDeposit before the approve exists, so it sends and simulates nothing.
# Read-back: the postDeposit receipt succeeded and its DepositPosted event carries the shortfall. depositOf(platform)
# is then printed; if a claim settled against the platform in between and it reads below the target, that is a
# warning, not a failure, and the row is still recorded.
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
target=${ARGS[0]:-}; [[ "$target" =~ ^[0-9]+$ ]] || die "usage: 07-deposit.sh <target-micro-usdc> [--send]"
HSH=$ROOT/contracts/script/hedera/hedera.sh
USDC=$VAULT_USDC
expect "Vault.usdc() is the recorded $VAULT_USDC_LABEL" "$(hcall "$VAULT" 'usdc()(address)')" "$USDC"
[ "$(hcall "$VAULT" 'usdcAssociated()(bool)')" = true ] || die "vault is not marked USDC-associated; run the associate step first"
platform=$(role_address platform)
before=$(hcall "$VAULT" 'depositOf(address)(uint256)' "$platform" | first)
need=$(python3 -c "print(max(0, $target - $before))")
log "depositOf(platform) is $before, target $target"
if [ "$need" = 0 ]; then log "already at or above the target; nothing to deposit"; exit 0; fi
usdc=$(hcall "$USDC" 'balanceOf(address)(uint256)' "$platform" | first)
log "platform $platform holds $usdc micro-$VAULT_USDC_SYMBOL ($VAULT_USDC_LABEL); deposit $need"
[ "$(python3 -c "print(int($usdc >= $need))")" = 1 ] || die "platform $VAULT_USDC_SYMBOL balance is below the shortfall $need"
if [ "$SEND" = 0 ]; then
  log "dry run: would run 'hedera.sh deposit $need --broadcast' as platform (approve, then postDeposit)"; exit 0
fi
out=$(HEDERA_FILE=$HEDERA_FILE HEDERA_RPC_URL_1=$HEDERA_RPC HEDERA_MIRROR_URL=$MIRROR HEDERA_REHEARSAL=$WIRE_LOCAL \
  "$HSH" deposit "$need" --broadcast) || { echo "$out"; die "hedera.sh deposit failed; re-run this step with the same target, it deposits only what is still missing"; }
echo "$out"
txid=$(grep -o 'postDeposit(address,uint256) ok: 0x[0-9a-fA-F]*' <<<"$out" | tail -1 | awk '{print $3}')
[ -n "$txid" ] || die "could not find the postDeposit tx in the output; check depositOf(platform) before re-running"
rcpt=$(cast receipt "$txid" --json --rpc-url "$HEDERA_RPC") || die "no receipt for postDeposit $txid"
[ "$(jq -r .status <<<"$rcpt")" = 0x1 ] || die "postDeposit $txid did not succeed"
topic=$(cast keccak 'DepositPosted(address,address,uint256,uint256)')
data=$(jq -r --arg v "$(lower "$VAULT")" --arg t "$(lower "$topic")" \
  '[.logs[] | select((.address | ascii_downcase) == $v and ((.topics[0] // "") | ascii_downcase) == $t)][-1].data // empty' <<<"$rcpt")
[ -n "$data" ] || die "postDeposit $txid has no DepositPosted event from the vault"
posted=$(python3 -c "print(int('${data:2:64}', 16))")
[ "$posted" = "$need" ] || die "read-back: DepositPosted carries $posted, wanted $need"
log "ok   DepositPosted $posted in $txid"
after=$(hcall "$VAULT" 'depositOf(address)(uint256)' "$platform" | first)
if [ "$(python3 -c "print(int($after >= $target))")" = 1 ]; then log "ok   depositOf(platform) = $after"
else log "WARN depositOf(platform) = $after, below the target $target although $need was posted (a settlement in between?)"; fi
wiring_step W8-deposit hedera "approve + postDeposit($platform, $need)" platform "$txid" "posted $need, depositOf = $after"
