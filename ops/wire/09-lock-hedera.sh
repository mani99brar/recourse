#!/usr/bin/env bash
# Step 9. Hedera: final parameters and lockConfig on RecourseClaims and DepositVault, through hedera.sh lock
# (the Lock script). Signs as the deployer. ONE WAY. After it only setExtraArgs, setFeeToken and setRequired
# remain. Run it only after the smoke claims have passed and the LINK / fee pool are topped to the lock targets.
# Read-back: configLocked() is true on both, and the locked parameter set reads back as written.
# Usage: 09-lock-hedera.sh [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
HSH=$ROOT/contracts/script/hedera/hedera.sh
export HEDERA_FILE HEDERA_RPC_URL_1=$HEDERA_RPC HEDERA_MIRROR_URL=$MIRROR HEDERA_REHEARSAL=$WIRE_LOCAL
if [ "$SEND" = 0 ]; then "$HSH" lock; exit 0; fi
[ "$(hcall "$CLAIMS" 'configLocked()(bool)')" = false ] || die "Claims is already locked"
"$HSH" lock --broadcast
expect "Claims.configLocked()" "$(hcall "$CLAIMS" 'configLocked()(bool)')" true
expect "Vault.configLocked()" "$(hcall "$VAULT" 'configLocked()(bool)')" true
# The lockConfig hashes come from the forge broadcast log of this run.
run=$ROOT/contracts/broadcast/Lock.s.sol/$H_CHAIN/run-latest.json
for pair in "$CLAIMS:claims" "$VAULT:vault"; do
  addr=${pair%%:*}; name=${pair##*:}
  h=$(jq -r --arg a "$(lower "$addr")" '[.transactions[] | select((.function // "") | startswith("lockConfig")) | select((.contractAddress // "" | ascii_downcase) == $a)][-1].hash // empty' "$run")
  [ -n "$h" ] || die "no lockConfig transaction for the $name in $run"
  wiring_step "L-lock-hedera-$name" hedera "lockConfig()" deployer "$h" "configLocked = true"
  wiring_update --arg n "$name" --arg tx "$h" --arg at "$(date -u +%FT%TZ)" '.lock[$n] = {tx:$tx, at:$at}'
done
