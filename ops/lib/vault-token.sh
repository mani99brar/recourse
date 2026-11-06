#!/usr/bin/env bash
# The vault's token, read from a Hedera deployment record with jq. Source it; do not run it.
#
#   vault_token <record file>   sets VAULT_USDC_MODE (circle|mock), VAULT_USDC (the ERC-20 address),
#                               VAULT_USDC_ID (the HTS token id; empty for the mock), VAULT_USDC_SYMBOL
#                               and VAULT_USDC_LABEL; prints why and returns 1 when the record is bad
#
# usdc.mode circle is Circle's testnet USDC 0.0.429274 at its ERC-20 facade; a record with no usdc
# object, or no record yet, is circle too. mock is the testnet mock mUSDC: a plain ERC-20 with no HTS
# token id and no mirror-node token rows, read by balanceOf over JSON-RPC, needing no association.
# The checks are those of vaultTokenOf in packages/shared, so the scripts and the services agree.

CIRCLE_USDC_ID=0.0.429274
CIRCLE_USDC=0x0000000000000000000000000000000000068cDa
ZERO_ADDRESS=0x0000000000000000000000000000000000000000

vault_token() {
  local f=$1 row mode addr idtype id dec
  VAULT_USDC_MODE=circle; VAULT_USDC=$CIRCLE_USDC; VAULT_USDC_ID=$CIRCLE_USDC_ID
  VAULT_USDC_SYMBOL=USDC; VAULT_USDC_LABEL=USDC
  [ -f "$f" ] || return 0
  # One tab-separated row; no field is empty (read would merge it away), and the tokenId's JSON type is
  # its own column beside its JSON text, so no string can pass for null. decimals is compared as a
  # number here, so 6.0 is 6.
  row=$(jq -r 'def text: if type == "string" and . != "" then . else tojson end;
    if has("usdc") | not then "none"
    elif (.usdc | type) != "object" then "bad"
    else .usdc | [(.mode | text), (.address | text),
                  (if has("tokenId") then (.tokenId | type, tojson) else ("missing", "missing") end),
                  (.decimals | if type == "number" and . == 6 then "6" else tojson end)] | @tsv end' "$f") \
    || { echo "vault token: $f is not valid JSON" >&2; return 1; }
  [ "$row" = none ] && return 0
  [ "$row" != bad ] || { echo "vault token: usdc in $f is not an object" >&2; return 1; }
  IFS=$'\t' read -r mode addr idtype id dec <<<"$row"
  [ "$mode" = circle ] || [ "$mode" = mock ] || { echo "vault token: usdc.mode in $f must be circle or mock, not $mode" >&2; return 1; }
  [ "$dec" = 6 ] || { echo "vault token: usdc.decimals in $f must be 6, not $dec" >&2; return 1; }
  [[ $addr =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "vault token: usdc.address in $f is not a 0x address: $addr" >&2; return 1; }
  case "$mode" in
    circle)
      [ "${addr,,}" = "${CIRCLE_USDC,,}" ] || { echo "vault token: circle mode in $f must name $CIRCLE_USDC, not $addr" >&2; return 1; }
      [ "$idtype" = string ] && [ "$id" = "\"$CIRCLE_USDC_ID\"" ] || { echo "vault token: circle mode in $f must name token $CIRCLE_USDC_ID, not $id" >&2; return 1; } ;;
    mock)
      [ "$idtype" = null ] || { echo "vault token: mock mode in $f has no HTS token id; tokenId must be null, not $id" >&2; return 1; }
      # Circle's facade under a mock label would skip its mirror association checks.
      [ "${addr,,}" != "${CIRCLE_USDC,,}" ] || { echo "vault token: mock mode in $f cannot name Circle's facade $addr" >&2; return 1; }
      [ "${addr,,}" != "$ZERO_ADDRESS" ] || { echo "vault token: mock mode in $f cannot name the zero address" >&2; return 1; }
      VAULT_USDC_MODE=mock; VAULT_USDC=$addr; VAULT_USDC_ID=""
      VAULT_USDC_SYMBOL=mUSDC; VAULT_USDC_LABEL="mUSDC (testnet mock)" ;;
  esac
}
