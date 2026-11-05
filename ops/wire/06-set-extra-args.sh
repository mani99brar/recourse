#!/usr/bin/env bash
# Step 6 (optional). CCIP extra args, only when the deploy scripts did not already set the intended bytes.
# Both setters stay available after the lock, so this can also run later. Signs as the deployer (the owner).
#   EXTRA_ARGS_HEDERA     0x bytes for Claims.setExtraArgs (Hedera to Arbitrum sends)
#   EXTRA_ARGS_ARBITRUM   0x bytes for RecourseCase.setExtraArgs (Arbitrum to Hedera sends)
# A side whose variable is unset is only read back, and the read-back must be non-empty.
# Read-back: extraArgs() on each contract equals the intended bytes.
# Usage: 06-set-extra-args.sh [--send]
. "$(dirname "$0")/lib.sh"
parse_args "$@"; check_chains both; load_deployed
side() { # side <label> <chain> <contract> <intended> <step id>
  local label=$1 chain=$2 c=$3 want=$4 id=$5 cur
  if [ "$chain" = hedera ]; then cur=$(hcall "$c" 'extraArgs()(bytes)'); else cur=$(acall "$c" 'extraArgs()(bytes)'); fi
  [ "$cur" != 0x ] || die "$label extraArgs() is empty; set it before any claim"
  if [ -z "$want" ] || [ "$(lower "$cur")" = "$(lower "$want")" ]; then
    log "ok   $label extraArgs() = $cur"; return
  fi
  tx "$chain" deployer "$c" 'setExtraArgs(bytes)' "$want"
  if [ "$SEND" = 1 ]; then
    if [ "$chain" = hedera ]; then cur=$(hcall "$c" 'extraArgs()(bytes)'); else cur=$(acall "$c" 'extraArgs()(bytes)'); fi
    expect "$label extraArgs()" "$cur" "$want"
    wiring_step "$id" "$chain" "setExtraArgs($want)" deployer "$LAST_TX" "extraArgs = $want"
  fi
}
side Claims hedera "$CLAIMS" "${EXTRA_ARGS_HEDERA:-}" W4-claims-extra-args
side RecourseCase arbitrum "$CASE" "${EXTRA_ARGS_ARBITRUM:-}" W4-case-extra-args
wiring_update --arg h "$(hcall "$CLAIMS" 'extraArgs()(bytes)')" --arg a "$(acall "$CASE" 'extraArgs()(bytes)')" \
  '.extraArgs = {toArbitrum: $h, toHedera: $a}'
