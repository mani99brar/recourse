#!/usr/bin/env bash
# Step 9. Hedera: final parameters and lockConfig on RecourseClaims and DepositVault, through hedera.sh lock
# (the Lock script). Signs as the deployer. ONE WAY. After it only setExtraArgs, setFeeToken and setRequired
# remain. Run it only after the smoke claims have passed and the LINK / fee pool are topped to the lock targets.
# Read-back: configLocked() is true on both, and the locked parameter set reads back as written.
#
# Quiesce first: the lock writes the locked contestWindow (1,800 s against 600 s before it), and contest() and
# closeUncontested() read the window live, so a claim already pre-checked would get a longer window than the one
# everyone was shown. The step refuses while the status API (STATUS_API_URL, default http://127.0.0.1:8787) lists
# a pre-checked claim (finding_made, no_finding, window_lapsed), or cannot be read. Stop the shop and the agent,
# wait for those claims to close, then lock. LOCK_IGNORE_OPEN_CLAIMS=1 skips the check (say why in the commit).
#
# Relay budget: after the lock neither Claims' claimTimeout nor its peer can change, so the gap between them and
# RecourseCase's claimTimeout is permanent. The step refuses unless the case's claimTimeout is at least the relay
# budget (CASE_RELAY_BUDGET, default 7200 s) below the locked claimTimeout (lib.sh timeout_gap): with less, a ruling
# given just before the case's cut-off can still be in flight when anyone may expire the claim on Hedera. Redeploy
# RecourseCase first (order.md, "Replacing a deployment"). LOCK_IGNORE_RELAY_BUDGET=1 locks anyway, with a warning.
# A case whose claimTimeout is above the locked one is always refused. On a half lock it only warns.
#
# Peer: the lock makes Claims.peer() permanent, so the step refuses unless it is the RecourseCase that
# $ARBITRUM_FILE records (the case 00-readback and the relay budget read). The Lock script checks the same peer
# against the same file, and the pre-check signer and ruling relayer against deployments/parties.json.
#
# A half lock: the Lock script sends claims.setParams, vault.setParams, claims.lockConfig, vault.lockConfig in
# that order. If the last one failed, Claims is locked and the vault is not, and the Lock script refuses to run
# again. This step then finishes the vault alone: it checks Claims' parameters are the locked set, sets the
# vault's locked parameters if they differ, and sends Vault.lockConfig(). Both locked: nothing to do.
# Usage: 09-lock-hedera.sh [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
HSH=$ROOT/contracts/script/hedera/hedera.sh
export HEDERA_FILE ARBITRUM_FILE HEDERA_RPC_URL_1=$HEDERA_RPC HEDERA_MIRROR_URL=$MIRROR HEDERA_REHEARSAL=$WIRE_LOCAL

locked() { jq -r --arg k "$1" '.locked[$k]' "$PARAMS_JSON"; }
claims_locked_set() { # the locked Claims.params() tuple, in the order cast prints it
  echo "$(locked contestWindow),$(locked claimTimeout),$(locked courtFeeUsdc),$(locked handlingBase),$(locked handlingBps),$(locked handlingCap),$(locked resendGap),$(locked maxSends)"
}
claims_params() { hcall "$CLAIMS" 'params()((uint64,uint64,uint256,uint256,uint16,uint256,uint64,uint8))' | sed -E 's/\[[^]]*\]//g; s/[() ]//g'; }
vault_params() { hcall "$VAULT" 'params()(uint64,uint64,uint256)' | first | paste -sd, -; }
vault_locked_set() { echo "$(locked topUpWindow),$(locked exitDelay),$(locked minDeposit)"; }

quiesced() { # dies unless no claim is pre-checked
  if [ "$WIRE_LOCAL" = 1 ]; then log "local rehearsal: no status API; open-claim check skipped"; return 0; fi
  if [ "${LOCK_IGNORE_OPEN_CLAIMS:-0}" = 1 ]; then log "WARN LOCK_IGNORE_OPEN_CLAIMS=1: open-claim check skipped"; return 0; fi
  local api=${STATUS_API_URL:-http://127.0.0.1:8787} body open
  body=$(curl -fsS --max-time 15 "${api%/}/claims") || die "cannot read ${api%/}/claims to check for pre-checked claims; start the status API or set LOCK_IGNORE_OPEN_CLAIMS=1"
  open=$(jq -r '[.rows[] | select(.statusKey == "finding_made" or .statusKey == "no_finding" or .statusKey == "window_lapsed") | .claimId] | join(" ")' <<<"$body") \
    || die "the status API answer has no claim rows"
  [ -z "$open" ] || die "pre-checked claims are still open: $open. The lock would stretch their contest window from 600 s to 1,800 s; wait until they close (closeUncontested or contest), then lock"
  log "ok   no pre-checked claim is open (status API)"
}

relay_budget_kept() { # dies unless RecourseCase's claimTimeout leaves the relay budget below the locked one
  local kt; kt=$(acall "$CASE" 'claimTimeout()(uint64)' | first)
  if timeout_gap "$kt" "$(locked claimTimeout)" "the claimTimeout the lock writes (params.json locked)"; then return 0; fi
  if [ "${LOCK_IGNORE_RELAY_BUDGET:-0}" = 1 ]; then
    log "WARN LOCK_IGNORE_RELAY_BUDGET=1: locking with the gap above; after the lock only a new Claims, vault and case can widen it"
    return 0
  fi
  die "refusing to lock: after the lock Claims' claimTimeout and peer are fixed, so the gap above would be permanent. Redeploy RecourseCase with the relay budget and repoint both peers first (order.md, Replacing a deployment), or set LOCK_IGNORE_RELAY_BUDGET=1 to lock anyway"
}

hl=$(hcall "$CLAIMS" 'configLocked()(bool)'); vl=$(hcall "$VAULT" 'configLocked()(bool)')
log "     locked now: claims $hl, vault $vl"

if [ "$hl" = true ] && [ "$vl" = true ]; then
  log "Claims and the vault are both locked already; nothing to do"; exit 0
fi
if [ "$hl" = false ] && [ "$vl" = true ]; then
  die "the vault is locked and Claims is not, which the Lock script never leaves behind; lock Claims by hand (setParams with the locked set, then lockConfig) and record it"
fi

if [ "$hl" = true ]; then
  # Half lock: Claims locked, vault not. Finish the vault.
  log "half lock: Claims is locked, the vault is not; finishing the vault"
  expect "Claims.params() is the locked set" "$(claims_params)" "$(claims_locked_set)"
  # Claims is locked already, so this cannot change here; a short or reversed gap does not stop the vault's lock.
  (timeout_gap "$(acall "$CASE" 'claimTimeout()(uint64)' | first)" "$(locked claimTimeout)" "Claims' locked claimTimeout") \
    || log "WARN finishing the vault lock anyway: Claims is locked, so only new contracts can change the gap above"
  if [ "$(vault_params)" != "$(vault_locked_set)" ]; then
    log "Vault.params() is $(vault_params); setting the locked set $(vault_locked_set)"
    tx hedera deployer "$VAULT" 'setParams(uint64,uint64,uint256)' "$(locked topUpWindow)" "$(locked exitDelay)" "$(locked minDeposit)"
    [ "$SEND" = 0 ] || wiring_step L-vault-params hedera "setParams($(vault_locked_set))" deployer "$LAST_TX" "params = $(vault_params)"
  fi
  tx hedera deployer "$VAULT" 'lockConfig()'
  [ "$SEND" = 1 ] || exit 0
  expect "Vault.params() is the locked set" "$(vault_params)" "$(vault_locked_set)"
  expect "Vault.configLocked()" "$(hcall "$VAULT" 'configLocked()(bool)')" true
  wiring_step L-lock-hedera-vault hedera "lockConfig()" deployer "$LAST_TX" "configLocked = true (finished a half lock)"
  wiring_update --arg tx "$LAST_TX" --arg at "$(date -u +%FT%TZ)" '.lock.vault = {tx:$tx, at:$at}'
  log "the Claims lockConfig of the earlier run is in contracts/broadcast/Lock.s.sol/$H_CHAIN/; record it in wiring.json .lock.claims by hand if it is missing"
  exit 0
fi

# Neither is locked: the normal path.
expect "Claims.peer() is the RecourseCase in $ARBITRUM_FILE" "$(hcall "$CLAIMS" 'peer()(address)')" "$CASE"
relay_budget_kept
quiesced
if [ "$SEND" = 0 ]; then "$HSH" lock; exit 0; fi
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
