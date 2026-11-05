#!/usr/bin/env bash
# Associate USDC (0.0.429274) with the roles that hold or move it. Each account associates
# itself by calling associate() on the token's ERC-20 facade address, signed with its own key.
# (Needs the account to be complete and to hold a little HBAR. If the facade call is refused on
# the network, use associate-usdc.mjs, which sends a native TokenAssociate transaction.)
# Usage: 04-associate-usdc.sh [--send]
source "$(dirname "$0")/lib.sh"; need_tools; parse_send_flag "$@"
for role in "${USDC_ROLES[@]}"; do
  if has_usdc "$role"; then echo "$role: USDC already associated"; continue; fi
  if ! is_complete "$role"; then
    echo "$role: not complete yet; run 02-fund-hedera-roles.sh first"
    if [[ $SEND == 1 ]]; then continue; fi
  fi
  send_cast "$role" "$HEDERA_RPC_URL_1" "$USDC_FACADE" "associate()" --gas-limit 1000000
done
if [[ $SEND == 1 ]]; then sleep 8; for r in "${USDC_ROLES[@]}"; do echo "$r associated: $(has_usdc "$r" && echo yes || echo NO)"; done; fi
