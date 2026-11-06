#!/usr/bin/env bash
# OPTIONAL top-up, not the main path: each role is normally funded straight from the faucet
# (at most 10 HBAR per address). If a role is short of its floor, the deployer sends the
# difference. A value transfer to an EVM address that has
# no account makes the network create a hollow account for it (lazy create); the role then pays
# for one self transaction to complete it, so it is a normal ECDSA account (x402 payers must not
# be hollow). Floors: see HBAR_DEFAULT in lib.sh. A new account costs 0.76 HBAR extra. Usage: 02-fund-hedera-roles.sh [--send]
source "$(dirname "$0")/lib.sh"; need_tools; parse_send_flag "$@"
if ! is_complete deployer; then
  echo "deployer is not complete yet; run 01-complete-hedera.sh --send first" >&2
  if [[ $SEND == 1 ]]; then exit 1; fi
fi
# Tinybar as a decimal HBAR string (8 places), for cast to-wei.
hbar_of() { printf '%d.%08d' $(($1 / 100000000)) $(($1 % 100000000)); }
# What each role is short of its floor, in tinybar (the whole floor when it has no account yet).
declare -A FLOOR=() SHORT=()
total=0
for role in precheck-signer platform agent shop scheme buyer facilitator; do
  v=HBAR_${role//-/_}; v=${v^^}; floor=${!v:-${HBAR_DEFAULT[$role]}}; FLOOR[$role]=$floor
  acct=$(mirror_account "$role"); have=0
  if [[ -n $(jq -r '.account // empty' <<<"$acct") ]]; then have=$(jq -r '.balance.balance // 0' <<<"$acct"); fi
  short=$((floor * 100000000 - have))
  if (( short < 0 )); then short=0; fi
  SHORT[$role]=$short; total=$((total + short))
done
bal=$(cast balance "$(addr deployer)" --rpc-url "$HEDERA_RPC_URL_1" --ether 2>/dev/null || echo 0)
echo "deployer holds $bal HBAR; this run sends $(hbar_of "$total") HBAR plus fees"
for role in precheck-signer platform agent shop scheme buyer facilitator; do
  amt=${FLOOR[$role]}
  if [[ $amt == 0 ]]; then echo "$role: needs no HBAR, skipping"; continue; fi
  if [[ ${SHORT[$role]} == 0 ]]; then
    echo "$role: already holds at least $amt HBAR, skipping transfer"
  else
    echo "$role: $(hbar_of "${SHORT[$role]}") HBAR short of its $amt HBAR floor"
    send_cast deployer "$HEDERA_RPC_URL_1" "$(addr "$role")" --value "$(cast to-wei "$(hbar_of "${SHORT[$role]}")")" --gas-limit 150000
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
