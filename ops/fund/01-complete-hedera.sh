#!/usr/bin/env bash
# Complete every Hedera role's account. Any HBAR send to an EVM address (faucet or another role)
# creates a hollow account with no key; one self-paid transaction signed by the key sets it.
# Roles with no HBAR yet, or already complete, are skipped. ops-arb has no Hedera account.
# Usage: 01-complete-hedera.sh [--send]
source "$(dirname "$0")/lib.sh"; need_tools; parse_send_flag "$@"
done_roles=()
for role in "${ALL_ROLES[@]}"; do
  [[ $role == ops-arb ]] && continue
  bal=$(cast balance "$(addr "$role")" --rpc-url "$HEDERA_RPC_URL_1" 2>/dev/null || echo 0)
  if [[ $bal == 0 ]]; then echo "$role: no HBAR yet; skipping"; continue; fi
  if is_complete "$role"; then echo "$role: already complete (ECDSA key set)"; continue; fi
  echo "$role: balance $bal weibar, hollow"
  complete_account "$role"
  done_roles+=("$role")
done
if [[ $SEND == 1 && ${#done_roles[@]} -gt 0 ]]; then
  sleep 8; for r in "${done_roles[@]}"; do echo "$r complete: $(is_complete "$r" && echo yes || echo NO)"; done
fi
