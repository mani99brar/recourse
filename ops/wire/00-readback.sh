#!/usr/bin/env bash
# Read-only check of the whole wiring, on both chains. Run it before the first step, after each step, and at the
# end. It sends nothing. With --record it also writes the values it read into deployments/wiring.json
# (contracts, peers, extraArgs, link, feePoolWei, association); it stops on the first mismatch. The vault's token
# must be the one $HEDERA_FILE records; Circle's USDC is also checked on the mirror node, the testnet mock (no
# HTS token, no mirror rows) by Vault.usdcAssociated() alone.
#   EXPECT_LOCKED=1   also require configLocked()/locked() true on all three contracts (default: only print)
#   EXPECT_PEERS=1    require both peers set (default 1; set 0 for the check before step 1)
# Usage: 00-readback.sh [--record]
. "$(dirname "$0")/lib.sh"
args=("${@/--record/--send}")
parse_args "${args[@]}"; check_chains both; load_deployed
zero=0x0000000000000000000000000000000000000000

if [ "${EXPECT_PEERS:-1}" = 1 ]; then
  expect "Claims.peer() is the RecourseCase" "$(hcall "$CLAIMS" 'peer()(address)')" "$CASE"
  expect "RecourseCase.peer() is Claims" "$(acall "$CASE" 'peer()(address)')" "$CLAIMS"
fi
expect "Claims.vault()" "$(hcall "$CLAIMS" 'vault()(address)')" "$VAULT"
expect "Vault.claims()" "$(hcall "$VAULT" 'claims()(address)')" "$CLAIMS"
dep=$(role_address deployer)
expect "Claims owner" "$(hcall "$CLAIMS" 'owner()(address)')" "$dep"
expect "Vault owner" "$(hcall "$VAULT" 'owner()(address)')" "$dep"
expect "RecourseCase owner" "$(acall "$CASE" 'owner()(address)')" "$dep"
# Role addresses come from the keystores, so a wrong key file is caught here.
expect "Claims.preCheckSigner()" "$(hcall "$CLAIMS" 'preCheckSigner()(address)')" "$(role_address precheck-signer)"
expect "Claims.rulingRelayer()" "$(hcall "$CLAIMS" 'rulingRelayer()(address)')" "$(role_address ops-hedera)"
expect "Vault.pool()" "$(hcall "$VAULT" 'pool()(address)')" "$(role_address scheme)"
tr=$(acall "$CASE" 'trustedRelay()(address)')
if [ "$(lower "$tr")" = "$zero" ]; then log "ok   RecourseCase.trustedRelay() = none"
else expect "RecourseCase.trustedRelay()" "$tr" "$(role_address ops-arb)"; fi
log "     Claims.bridgeMode() = $(hcall "$CLAIMS" 'bridgeMode()(uint8)') (0 Both, 1 OutOnly, 2 None)"
ft=$(hcall "$CLAIMS" 'feeToken()(address)'); log "     Claims.feeToken() = $ft (zero = native)"
xh=$(hcall "$CLAIMS" 'extraArgs()(bytes)'); xa=$(acall "$CASE" 'extraArgs()(bytes)')
[ "$xh" != 0x ] && [ "$xa" != 0x ] || die "an extraArgs() is empty"
log "ok   extraArgs: Claims $xh, RecourseCase $xa"

cl=0; if [ "$(lower "$ft")" != "$zero" ]; then cl=$(hcall "$ft" 'balanceOf(address)(uint256)' "$CLAIMS" | first); fi
cn=$(cast balance "$CLAIMS" --rpc-url "$HEDERA_RPC")
kl=$(acall "$ALINK" 'balanceOf(address)(uint256)' "$CASE" | first)
fp=$(acall "$CASE" 'feePool()(uint256)' | first)
log "     Claims LINK $cl, Claims native $cn weibar, Case LINK $kl, Case feePool $fp wei"

expect "Vault.usdc() is the recorded $VAULT_USDC_LABEL" "$(hcall "$VAULT" 'usdc()(address)')" "$VAULT_USDC"
assoc=$(hcall "$VAULT" 'usdcAssociated()(bool)')
expect "Vault.usdcAssociated()" "$assoc" true
if [ "$VAULT_USDC_MODE" = mock ]; then rows="none (mock USDC, not an HTS token)"; log "ok   $VAULT_USDC_LABEL needs no mirror association row"
elif [ "$WIRE_LOCAL" = 1 ]; then rows="local (no mirror)"
else
  rows=$(curl -fsS --max-time 15 "$MIRROR/api/v1/accounts/$VAULT/tokens?token.id=$VAULT_USDC_ID" | jq '.tokens | length') || die "mirror did not answer"
  [ "$rows" = 1 ] || die "mirror shows $rows USDC rows for the vault, wanted 1"
  log "ok   mirror lists the vault's USDC association"
fi
hl=$(hcall "$CLAIMS" 'configLocked()(bool)'); vl=$(hcall "$VAULT" 'configLocked()(bool)'); kl2=$(acall "$CASE" 'locked()(bool)')
log "     locked: claims $hl, vault $vl, case $kl2"
if [ "${EXPECT_LOCKED:-0}" = 1 ]; then
  [ "$hl" = true ] && [ "$vl" = true ] && [ "$kl2" = true ] || die "EXPECT_LOCKED=1 but not all three are locked"
fi
log "read-back OK"
wiring_update --arg c "$CLAIMS" --arg v "$VAULT" --arg k "$CASE" --arg xh "$xh" --arg xa "$xa" \
  --arg cl "$cl" --arg kl "$kl" --arg fp "$fp" --arg rows "$rows" --arg at "$(date -u +%FT%TZ)" \
  --arg um "$VAULT_USDC_MODE" --arg ua "$VAULT_USDC" \
  --arg vid "$(jq -r '.contracts.vault.id // empty' "$DEPLOY_DIR/$HEDERA_FILE")" \
  '.contracts = {claims:$c, vault:$v, case:$k}
   | .extraArgs = {toArbitrum:$xh, toHedera:$xa}
   | .link = {claims:$cl, case:$kl}
   | .feePoolWei = $fp
   | .association = {vault:$vid, usdcMode:$um, usdc:$ua, mirrorRows:$rows, checkedAt:$at}'
