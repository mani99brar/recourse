#!/usr/bin/env bash
# Complete the two accounts the operator funds from the faucet (deployer, ops-hedera): a faucet
# send to an EVM address creates a hollow account with no key; one self-paid transaction signed
# by the key sets it. Needs HBAR on both. Usage: 01-complete-hedera.sh [--send]
source "$(dirname "$0")/lib.sh"; need_tools; parse_send_flag "$@"
for role in deployer ops-hedera; do
  bal=$(cast balance "$(addr "$role")" --rpc-url "$HEDERA_RPC_URL_1" 2>/dev/null || echo 0)
  echo "$role: balance $bal weibar"
  if [[ $bal == 0 && $SEND == 1 ]]; then echo "$role holds no HBAR yet; skipping"; continue; fi
  complete_account "$role"
done
if [[ $SEND == 1 ]]; then sleep 8; for r in deployer ops-hedera; do echo "$r complete: $(is_complete "$r" && echo yes || echo NO)"; done; fi
