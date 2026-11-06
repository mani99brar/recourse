#!/usr/bin/env bash
# Read-only check of the whole wiring, on both chains. Run it before the first step, after each step, and at the
# end. It sends nothing. With --record it also writes the values it read into deployments/wiring.json
# (contracts, peers, extraArgs, link, feePoolWei, association); it stops on the first mismatch. It also checks the
# parameters the two chains share: resendGap and maxSends must be equal in Claims.params() and RecourseCase.params(),
# and that Claims' extra args give the Arbitrum receive at least the gas measured in $ARBITRUM_FILE
# (gas.ccipReceive.limit). claimTimeout must NOT be equal: RecourseCase's (fixed at deploy, and the one in
# $ARBITRUM_FILE constructorArgs) must be at least the relay budget (CASE_RELAY_BUDGET, default 7200 s) below both
# Claims' live value and the params.json locked value Claims takes at the lock. Above either it stops; short of the
# budget (equal included) it warns, since only a RecourseCase redeploy can widen it. Once Claims is locked its
# claimTimeout must be the params.json locked value. The vault's token
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
# The gas limit inside CCIP extra args: a V1 (0x97a657c9) or V2 (0x181dcf10) tag, then a uint256 gasLimit.
gas_of() { local x=${1#0x}; case "${x:0:8}" in 97a657c9|181dcf10) python3 -c "print(int('${x:8:64}', 16))" ;; *) echo "" ;; esac; }
gh=$(gas_of "$xh"); ga=$(gas_of "$xa")
[ -n "$gh" ] || die "Claims.extraArgs() is not CCIP V1 or V2 extra args: $xh"
[ -n "$ga" ] || die "RecourseCase.extraArgs() is not CCIP V1 or V2 extra args: $xa"
need_gas=$(jq -r '.gas.ccipReceive.limit // empty' "$DEPLOY_DIR/$ARBITRUM_FILE")
if [ -n "$need_gas" ]; then
  [ "$gh" -ge "$need_gas" ] || die "Claims' extra args give the Arbitrum receive $gh gas, below the measured ccipReceive limit $need_gas ($ARBITRUM_FILE gas)"
  log "ok   Claims' extra args gas $gh >= RecourseCase ccipReceive limit $need_gas"
else
  log "     Claims' extra args gas $gh (no measured ccipReceive gas in $ARBITRUM_FILE to compare)"
fi
log "     RecourseCase's extra args gas $ga (no measured Hedera receive cost on record to compare)"

# Parameters the two chains share. Claims.params() is (contestWindow, claimTimeout, courtFeeUsdc,
# handlingBase, handlingBps, handlingCap, resendGap, maxSends); RecourseCase.params() is (caseDeadline,
# maxOpenCases, resendGap, maxSends) and its claimTimeout() is immutable. resendGap and maxSends are equal;
# claimTimeout is not (see the header).
hp=$(hcall "$CLAIMS" 'params()((uint64,uint64,uint256,uint256,uint16,uint256,uint64,uint8))' | sed -E 's/\[[^]]*\]//g; s/[() ]//g')
[ "$(awk -F, '{print NF}' <<<"$hp")" = 8 ] || die "Claims.params() did not decode to 8 fields: $hp"
ap=$(acall "$CASE" 'params()(uint64,uint16,uint64,uint8)' | first | paste -sd, -)
[ "$(awk -F, '{print NF}' <<<"$ap")" = 4 ] || die "RecourseCase.params() did not decode to 4 fields: $ap"
hl=$(hcall "$CLAIMS" 'configLocked()(bool)'); vl=$(hcall "$VAULT" 'configLocked()(bool)'); kl2=$(acall "$CASE" 'locked()(bool)')
# claimTimeout: the case's is the shorter, by at least the relay budget (lib.sh timeout_gap).
kt=$(acall "$CASE" 'claimTimeout()(uint64)' | first); ht=$(cut -d, -f2 <<<"$hp")
lt=$(jq -er '.locked.claimTimeout' "$PARAMS_JSON") || die "no locked.claimTimeout in $PARAMS_JSON"
rt=$(jq -r '.constructorArgs.claimTimeout // empty' "$DEPLOY_DIR/$ARBITRUM_FILE")
if [ -n "$rt" ]; then expect "RecourseCase.claimTimeout() is $ARBITRUM_FILE constructorArgs.claimTimeout" "$kt" "$rt"
else log "     RecourseCase.claimTimeout() $kt ($ARBITRUM_FILE records no constructorArgs.claimTimeout to compare)"; fi
if [ "$hl" = true ]; then expect "Claims is locked: Claims.params() claimTimeout is params.json locked.claimTimeout" "$ht" "$lt"; fi
timeout_gap "$kt" "$ht" "Claims.params() claimTimeout" || true
if [ "$ht" != "$lt" ]; then timeout_gap "$kt" "$lt" "params.json locked.claimTimeout (Claims' value after the lock)" || true; fi
expect "resendGap: Claims.params() equals RecourseCase.params()" "$(cut -d, -f7 <<<"$hp")" "$(cut -d, -f3 <<<"$ap")"
expect "maxSends: Claims.params() equals RecourseCase.params()" "$(cut -d, -f8 <<<"$hp")" "$(cut -d, -f4 <<<"$ap")"

cl=0; if [ "$(lower "$ft")" != "$zero" ]; then cl=$(hcall "$ft" 'balanceOf(address)(uint256)' "$CLAIMS" | first); fi
cn=$(cast balance "$CLAIMS" --rpc-url "$HEDERA_RPC")
kl=$(acall "$ALINK" 'balanceOf(address)(uint256)' "$CASE" | first)
fp=$(acall "$CASE" 'feePool()(uint256)' | first)
log "     Claims LINK $cl, Claims native $cn weibar, Case LINK $kl, Case feePool $fp wei"
# Warnings only: a short balance does not stop the read-back, but the next send of that kind will fail or fall back.
if [ "$(lower "$ft")" != "$zero" ] && [ "$(python3 -c "print(int($cl < 10**18))")" = 1 ]; then
  log "WARN Claims holds less than 1 LINK for CCIP fees; top it up with 03-fund-claims.sh"
elif [ "$(lower "$ft")" = "$zero" ] && [ "$(python3 -c "print(int($cn < 10**18))")" = 1 ]; then
  log "WARN Claims holds less than 1 HBAR for native CCIP fees; top it up with 03-fund-claims.sh"
fi
if [ "$kl" = 0 ]; then log "WARN RecourseCase holds no LINK: a ruling can only go back by relayRuling paid in ETH (the keeper pays it from ops-arb)"; fi

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
log "     locked: claims $hl, vault $vl, case $kl2"
if [ "${EXPECT_LOCKED:-0}" = 1 ]; then
  [ "$hl" = true ] && [ "$vl" = true ] && [ "$kl2" = true ] || die "EXPECT_LOCKED=1 but not all three are locked"
fi
log "read-back OK"
wiring_retire_moved
wiring_update --arg c "$CLAIMS" --arg v "$VAULT" --arg k "$CASE" --arg xh "$xh" --arg xa "$xa" \
  --arg cl "$cl" --arg kl "$kl" --arg fp "$fp" --arg rows "$rows" --arg at "$(date -u +%FT%TZ)" \
  --arg um "$VAULT_USDC_MODE" --arg ua "$VAULT_USDC" \
  --arg vid "$(jq -r '.contracts.vault.id // empty' "$DEPLOY_DIR/$HEDERA_FILE")" \
  --arg hpeer "$(hcall "$CLAIMS" 'peer()(address)')" --arg apeer "$(acall "$CASE" 'peer()(address)')" \
  --arg asel "$(hcall "$CLAIMS" 'arbSelector()(uint64)' | first)" --arg hsel "$(acall "$CASE" 'hederaSelector()(uint64)' | first)" \
  '.contracts = {claims:$c, vault:$v, case:$k}
   | .peers = {casePeer:$hpeer, arbSelector:$asel, claimsPeer:$apeer, hederaSelector:$hsel, readAt:$at}
   | .extraArgs = {toArbitrum:$xh, toHedera:$xa}
   | .link = {claims:$cl, case:$kl}
   | .feePoolWei = $fp
   | .association = {vault:$vid, usdcMode:$um, usdc:$ua, mirrorRows:$rows, checkedAt:$at}'
