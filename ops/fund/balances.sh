#!/usr/bin/env bash
# Read-only: every role's HBAR, USDC, LINK on Hedera, LINK on Arbitrum Sepolia and Arbitrum Sepolia ETH.
# The USDC column is the vault's token, by balanceOf: Circle's (0.0.429274), or the testnet mock that
# the deployment record names, headed mUSDC. Sends nothing. "-" = the read failed (for USDC and Hedera
# LINK that is also what a not-yet-created account gives). Usage: balances.sh
source "$(dirname "$0")/lib.sh"; need_tools
h() { cast balance "$1" --rpc-url "$HEDERA_RPC_URL_1" --ether 2>/dev/null | awk '{printf "%.4f", $1}' || echo "?"; }
e() { cast balance "$1" --rpc-url "$ARB_RPC_URL" --ether 2>/dev/null | awk '{printf "%.6f", $1}' || echo "?"; }
tok() { # token rpc address decimals
  local raw; raw=$(cast call "$1" "balanceOf(address)(uint256)" "$3" --rpc-url "$2" 2>/dev/null | awk '{print $1}')
  [[ -n $raw ]] || { echo "-"; return; }
  awk -v r="$raw" -v d="$4" 'BEGIN{printf "%.4f", r/(10^d)}'
}
date -u +"balances read %Y-%m-%d %H:%M:%S UTC"
[[ $VAULT_USDC_MODE == mock ]] && echo "USDC column: $VAULT_USDC_LABEL at $VAULT_USDC, not Circle's USDC"
printf '%-16s %-44s %12s %12s %12s %12s %14s\n' role address "HBAR" "$VAULT_USDC_SYMBOL" "LINK(hed)" "LINK(arb)" "ETH(arb)"
for role in "${ALL_ROLES[@]}"; do
  a=$(addr "$role")
  printf '%-16s %-44s %12s %12s %12s %12s %14s\n' "$role" "$a" "$(h "$a")" "$(tok $USDC_FACADE "$HEDERA_RPC_URL_1" "$a" 6)" \
    "$(tok $H_LINK "$HEDERA_RPC_URL_1" "$a" 18)" "$(tok $A_LINK "$ARB_RPC_URL" "$a" 18)" "$(e "$a")"
done
