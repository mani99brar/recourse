#!/usr/bin/env bash
# The deployer sends HBAR to every other Hedera role. A value transfer to an EVM address that has
# no account makes the network create a hollow account for it (lazy create); the role then pays
# for one self transaction to complete it, so it is a normal ECDSA account (x402 payers must not
# be hollow). Amounts: see HBAR_DEFAULT in lib.sh. Usage: 02-fund-hedera-roles.sh [--send]
source "$(dirname "$0")/lib.sh"; need_tools; parse_send_flag "$@"
if ! is_complete deployer; then
  echo "deployer is not complete yet; run 01-complete-hedera.sh --send first" >&2
  if [[ $SEND == 1 ]]; then exit 1; fi
fi
total=0
for role in "${!HBAR_DEFAULT[@]}"; do
  v=HBAR_${role//-/_}; v=${v^^}; amt=${!v:-${HBAR_DEFAULT[$role]}}
  total=$((total + amt))
done
bal=$(cast balance "$(addr deployer)" --rpc-url "$HEDERA_RPC_URL_1" --ether 2>/dev/null || echo 0)
echo "deployer holds $bal HBAR; this run sends $total HBAR plus fees"
for role in precheck-signer platform agent shop scheme buyer facilitator; do
  v=HBAR_${role//-/_}; v=${v^^}; amt=${!v:-${HBAR_DEFAULT[$role]}}
  if [[ -n $(account_id "$role") && $(mirror_account "$role" | jq -r '.balance.balance') -ge $((amt * 100000000)) ]]; then
    echo "$role: already holds at least $amt HBAR, skipping transfer"
  else
    send_cast deployer "$HEDERA_RPC_URL_1" "$(addr "$role")" --value "$(cast to-wei "$amt")" --gas-limit 150000
  fi
done
if [[ $SEND == 1 ]]; then
  echo "waiting for the mirror node"; sleep 10
  for role in precheck-signer platform agent shop scheme buyer facilitator; do complete_account "$role"; done
  sleep 8
  for role in "${HEDERA_ROLES[@]}"; do echo "$role: $(account_id "$role") complete=$(is_complete "$role" && echo yes || echo NO)"; done
else
  for role in precheck-signer platform agent shop scheme buyer facilitator; do echo "+ self tx to complete $role (after its account exists)"; done
fi
