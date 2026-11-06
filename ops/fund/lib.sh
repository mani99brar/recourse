#!/usr/bin/env bash
# Shared helpers for the funding and account scripts. Source it; do not run it.
#
# Safety: every script here only PRINTS what it would send unless called with --send.
# Keys are used only through Foundry keystores (--keystore/--password-file); nothing secret is
# ever placed in argv, logs or files written here.
#
# Order once the deployer and ops-hedera hold HBAR and the deployer holds Arbitrum Sepolia ETH:
#   01-complete-hedera.sh   deployer and ops-hedera: one self-paid tx each, so neither is hollow
#   02-fund-hedera-roles.sh deployer sends HBAR to every other Hedera role (creates the account),
#                           then each role pays for one self tx (completes it)
#   03-fund-arbitrum.sh     deployer sends Arbitrum Sepolia ETH to ops-arb
#   04-associate-usdc.sh    associate USDC 0.0.429274 for the seven roles that hold or move it
#   05-write-ids.sh         read account ids from the mirror node, write HEDERA_ACCOUNT_IDS and
#                           deployments/parties.json
#   balances.sh             read-only table of every role's HBAR, USDC, LINK and Arbitrum ETH

set -euo pipefail

FUND_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$FUND_DIR/../.." && pwd)

KEYSTORE_DIR=${KEYSTORE_DIR:-$HOME/.config/recourse/keys}
ADDRS_FILE=${ADDRS_FILE:-$HOME/.config/recourse/addresses.txt}
ENV_FILE=${RECOURSE_ENV_FILE:-$HOME/.config/recourse/recourse.env}
HEDERA_RPC_URL_1=${HEDERA_RPC_URL_1:-https://testnet.hashio.io/api}
ARB_RPC_URL=${ARB_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}
MIRROR=${HEDERA_MIRROR_URL:-https://testnet.mirrornode.hedera.com}
MIRROR=${MIRROR%/}; MIRROR=${MIRROR%/api/v1}

USDC_TOKEN=0.0.429274
USDC_FACADE=0x0000000000000000000000000000000000068cda   # HTS token facade (ERC-20 view of 0.0.429274)
H_LINK=0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6
A_LINK=0xb1D4538B4571d411F07960EF2838Ce337FE1E80E

ALL_ROLES=(deployer ops-hedera ops-arb precheck-signer platform agent shop scheme buyer facilitator)
HEDERA_ROLES=(deployer ops-hedera precheck-signer platform agent shop scheme buyer facilitator)
USDC_ROLES=(platform agent shop scheme ops-hedera buyer facilitator)

# Optional top-up: HBAR the deployer sends to another role when its own faucet claim fell short.
# The faucet pays at most 10 HBAR per address, so each role is normally funded directly and
# these amounts are the floors a role needs, all under 10. Roles at 0 need nothing (the public
# facilitators are used before the self-hosted one). Override with e.g. HBAR_SHOP=4.
# Measured costs on 5 Nov: an account created by a value transfer costs 0.76 HBAR on top of
# the value; completing a hollow account costs 0.026 HBAR.
# The agent pays its record fees in HBAR. With PRICE_ASSET=hbar (from the environment, else from
# the env file the services load, read the way ops/wire/lib.sh reads it) it also pays each x402
# order in HBAR, 1 to 6 HBAR at quantity 1, so its floor is 8 HBAR then (one 6 HBAR order plus
# fees), else 2.
env_price_asset() {
  [[ -f $ENV_FILE ]] || return 0
  ( set +eu; set -a; . "$ENV_FILE" >/dev/null 2>&1; printf %s "${PRICE_ASSET:-}" ) || true
}
FUND_PRICE_ASSET=${PRICE_ASSET:-$(env_price_asset)}
AGENT_HBAR_FLOOR=2
if [[ ${FUND_PRICE_ASSET,,} == hbar ]]; then AGENT_HBAR_FLOOR=8; fi
declare -A HBAR_DEFAULT=(
  [precheck-signer]=3 [platform]=1 [agent]=$AGENT_HBAR_FLOOR [shop]=3 [scheme]=1 [buyer]=0 [facilitator]=0
)
# Arbitrum Sepolia ETH the deployer sends to ops-arb (of about 0.05 ETH in total).
ARB_ETH_TO_OPS=${ARB_ETH_TO_OPS:-0.035}

SEND=0
parse_send_flag() { for a in "$@"; do [[ $a == --send ]] && SEND=1; done; if [[ $SEND == 0 ]]; then echo "# dry run: nothing is sent; add --send to send"; fi; }

addr() { awk -v r="$1" '$1==r {print $2}' "$ADDRS_FILE"; }
ks() { echo "--keystore $KEYSTORE_DIR/$1.json --password-file $KEYSTORE_DIR/$1.json.pass"; }

need_tools() { for t in cast jq curl; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done; }

# mirror_account <role|address> -> account JSON on stdout (empty on 404)
mirror_account() {
  local a=$1; [[ $a == 0x* ]] || a=$(addr "$a")
  curl -s -m 20 -f "$MIRROR/api/v1/accounts/$a" 2>/dev/null || true
}
account_id() { mirror_account "$1" | jq -r '.account // empty'; }
# complete = an ECDSA key is set on the account (hollow accounts have no key yet)
is_complete() { [[ $(mirror_account "$1" | jq -r '.key._type // empty') == ECDSA_SECP256K1 ]]; }
has_usdc() {
  local id; id=$(account_id "$1"); [[ -n $id ]] || return 1
  [[ $(curl -s -m 20 "$MIRROR/api/v1/accounts/$id/tokens?token.id=$USDC_TOKEN" | jq -r '.tokens | length') -ge 1 ]]
}

# send_cast <role> <rpc> <cast send args...>   (signs with that role's keystore)
send_cast() {
  local role=$1 rpc=$2; shift 2
  echo "+ cast send $* [signer: $role]"
  [[ $SEND == 1 ]] || return 0
  cast send "$@" --keystore "$KEYSTORE_DIR/$role.json" --password-file "$KEYSTORE_DIR/$role.json.pass" --rpc-url "$rpc" --legacy
}

# One tiny self-paid transfer (1 tinybar) from the role to itself. On Hedera, an Ethereum
# transaction signed by a hollow account's key completes the account (sets its ECDSA key).
complete_account() {
  local role=$1 a; a=$(addr "$role")
  if is_complete "$role"; then echo "$role: already complete (ECDSA key set)"; return 0; fi
  [[ -n $(account_id "$role") ]] || echo "$role: no account on the mirror yet (needs HBAR first)"
  send_cast "$role" "$HEDERA_RPC_URL_1" "$a" --value 10000000000 --gas-limit 30000
}
