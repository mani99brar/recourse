#!/usr/bin/env bash
# Shared helpers for the wiring scripts. Source it; do not run it.
#
# Every step script is a dry run unless called with --send. A dry run reads the chains and simulates the call
# (eth_call from the signer) and sends nothing. A sent step reads the value back and stops on a mismatch, then
# appends one row to deployments/wiring.json.
#
# Keys are used only through Foundry keystores: --keystore "$KEYSTORE_DIR/<role>.json" --password-file <same>.pass.
# No key, password or keyed URL is ever placed in argv, a log line or a file written here.
#
# Environment (the shared env file is sourced for a real run; a local run uses only what is exported):
#   KEYSTORE_DIR            keystore directory (required to sign)
#   HEDERA_RPC_URL_1        Hedera JSON-RPC (default: the public testnet relay)
#   ARB_RPC_URL             Arbitrum Sepolia JSON-RPC (default: the public endpoint)
#   HEDERA_MIRROR_URL       mirror node host (default: the public testnet mirror)
#   HEDERA_FILE             name of the Hedera deployments file in deployments/ (default hedera.json)
#   ARBITRUM_FILE           name of the Arbitrum deployments file (default arbitrum.json)
#   WIRING_FILE             name of the wiring record in deployments/ (default wiring.json)
#   WIRE_LOCAL=1            local rehearsal: both chains must be local, and the three file names above must
#                           be their own *.local.json names (never hedera.local.json or arbitrum.local.json)
#   HEDERA_LINK, ARB_LINK   LINK token addresses (default: the testnet ones; a local run reads them from the files)
#
# The vault's USDC is the token the Hedera file records (load_deployed sets VAULT_USDC_MODE, VAULT_USDC and
# the rest, see ops/lib/vault-token.sh): Circle's 0.0.429274, or the testnet mock mUSDC, which has no HTS id.
set -euo pipefail

WIRE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$WIRE_DIR/../.." && pwd)
export PATH="$HOME/.local/bin:$PATH"

WIRE_LOCAL=${WIRE_LOCAL:-0}
if [ "$WIRE_LOCAL" != 1 ]; then
  ENV_FILE=${RECOURSE_ENV_FILE:-$HOME/.config/recourse/recourse.env}
  if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
fi

DEPLOY_DIR=$ROOT/deployments
HEDERA_FILE=${HEDERA_FILE:-hedera.json}
ARBITRUM_FILE=${ARBITRUM_FILE:-arbitrum.json}
WIRING_FILE=${WIRING_FILE:-wiring.json}
HEDERA_RPC=${HEDERA_RPC_URL_1:-https://testnet.hashio.io/api}
ARB_RPC=${ARB_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}
MIRROR=${HEDERA_MIRROR_URL:-https://testnet.mirrornode.hedera.com}
MIRROR=${MIRROR%/}; MIRROR=${MIRROR%/api/v1}
# shellcheck source=../lib/vault-token.sh
. "$ROOT/ops/lib/vault-token.sh"
H_LINK_TESTNET=0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6
A_LINK_TESTNET=0xb1D4538B4571d411F07960EF2838Ce337FE1E80E
PARAMS_JSON=$ROOT/packages/shared/vectors/params.json
ADDRS_FILE=${ADDRS_FILE:-$HOME/.config/recourse/addresses.txt}

die() { echo "wire: $*" >&2; exit 1; }
log() { echo "wire: $*"; }

SEND=0
parse_args() { # leaves the non-flag arguments in ARGS
  ARGS=()
  for a in "$@"; do
    case "$a" in
      --send) SEND=1 ;;
      -h|--help) sed -n '2,/^[^#]/p' "$0" | sed '$d'; exit 0 ;;
      *) ARGS+=("$a") ;;
    esac
  done
  if [ "$SEND" = 0 ]; then echo "# dry run: nothing is sent and wiring.json is not written; add --send to broadcast"; fi
}

need_tools() { for t in cast jq curl python3; do command -v "$t" >/dev/null || die "missing tool: $t"; done; }

# --- chain guards ------------------------------------------------------------------------------------------------
H_CHAIN=""; A_CHAIN=""
check_chains() { # check_chains hedera|arbitrum|both
  need_tools
  if [ "$1" = hedera ] || [ "$1" = both ]; then
    H_CHAIN=$(cast chain-id --rpc-url "$HEDERA_RPC") || die "Hedera RPC does not answer"
  fi
  if [ "$1" = arbitrum ] || [ "$1" = both ]; then
    A_CHAIN=$(cast chain-id --rpc-url "$ARB_RPC") || die "Arbitrum RPC does not answer"
  fi
  if [ "$WIRE_LOCAL" = 1 ]; then
    for c in "$H_CHAIN" "$A_CHAIN"; do
      case "$c" in 295|296|1|42161|421614|11155111) die "WIRE_LOCAL=1 but a chain id is $c" ;; esac
    done
    for f in "$HEDERA_FILE" "$ARBITRUM_FILE" "$WIRING_FILE"; do
      case "$f" in */*) die "file name $f must be a bare name" ;; esac
      case "$f" in hedera.local.json|arbitrum.local.json) die "a local run must name its own file, not $f" ;; esac
      case "$f" in *.local.json) ;; *) die "a local run needs a *.local.json name, got $f" ;; esac
    done
  else
    [ -z "$H_CHAIN" ] || [ "$H_CHAIN" = 296 ] || die "Hedera chain id is $H_CHAIN, not 296"
    [ -z "$A_CHAIN" ] || [ "$A_CHAIN" = 421614 ] || die "Arbitrum chain id is $A_CHAIN, not 421614"
    for f in "$HEDERA_FILE" "$ARBITRUM_FILE" "$WIRING_FILE"; do
      case "$f" in *.local.json) die "$f is a local file; unset it for a testnet run" ;; esac
    done
  fi
}

# --- deployments -------------------------------------------------------------------------------------------------
load_deployed() {
  [ -f "$DEPLOY_DIR/$HEDERA_FILE" ] || die "no $HEDERA_FILE in deployments/"
  [ -f "$DEPLOY_DIR/$ARBITRUM_FILE" ] || die "no $ARBITRUM_FILE in deployments/"
  CLAIMS=$(jq -er .contracts.claims.address "$DEPLOY_DIR/$HEDERA_FILE")
  VAULT=$(jq -er .contracts.vault.address "$DEPLOY_DIR/$HEDERA_FILE")
  CASE=$(jq -er .contracts.case.address "$DEPLOY_DIR/$ARBITRUM_FILE")
  vault_token "$DEPLOY_DIR/$HEDERA_FILE" || die "the usdc object in $HEDERA_FILE does not validate"
  if [ "$WIRE_LOCAL" = 1 ]; then
    HLINK=${HEDERA_LINK:-$(jq -er .local.link "$DEPLOY_DIR/$HEDERA_FILE")}
    ALINK=${ARB_LINK:-$(jq -er .mocks.link "$DEPLOY_DIR/$ARBITRUM_FILE")}
  else
    HLINK=${HEDERA_LINK:-$H_LINK_TESTNET}
    ALINK=${ARB_LINK:-$A_LINK_TESTNET}
  fi
  [ "$(cast code "$CLAIMS" --rpc-url "$HEDERA_RPC" | wc -c)" -gt 3 ] || die "no code at Claims $CLAIMS on the Hedera RPC"
  [ "$(cast code "$CASE" --rpc-url "$ARB_RPC" | wc -c)" -gt 3 ] || die "no code at RecourseCase $CASE on the Arbitrum RPC"
}

# --- keys --------------------------------------------------------------------------------------------------------
KS=()
keystore() { # keystore <role>: sets KS to the cast signing flags
  [ -n "${KEYSTORE_DIR:-}" ] || die "KEYSTORE_DIR is not set"
  local ks="$KEYSTORE_DIR/$1.json"
  [ -f "$ks" ] && [ -f "$ks.pass" ] || die "missing keystore or password file for role $1"
  KS=(--keystore "$ks" --password-file "$ks.pass")
}
role_address() { keystore "$1"; cast wallet address "${KS[@]}"; }

# --- reads -------------------------------------------------------------------------------------------------------
hcall() { cast call "$1" "$2" "${@:3}" --rpc-url "$HEDERA_RPC"; }
acall() { cast call "$1" "$2" "${@:3}" --rpc-url "$ARB_RPC"; }
first() { awk '{print $1}'; }   # cast prints "123 [1.23e2]" for big numbers; keep the number
lower() { tr 'A-F' 'a-f' <<<"$1"; }
expect() { # expect <label> <got> <want>
  [ "$(lower "$2")" = "$(lower "$3")" ] || die "read-back mismatch: $1 is $2, wanted $3"
  log "ok   $1 = $2"
}

# --- sending -----------------------------------------------------------------------------------------------------
LAST_TX=""
# tx <hedera|arbitrum> <role> <to> <signature> [args and cast flags...]
# Dry run: eth_call from the role's address (and report). Send: cast send, status must be 0x1.
tx() {
  local chain=$1 role=$2 to=$3 sig=$4; shift 4
  local rpc=$HEDERA_RPC; [ "$chain" = arbitrum ] && rpc=$ARB_RPC
  keystore "$role"
  LAST_TX=""
  if [ "$SEND" = 1 ]; then
    local r; r=$(cast send "$to" "$sig" "$@" --rpc-url "$rpc" "${KS[@]}" --json) || die "$sig failed to send"
    [ "$(jq -r .status <<<"$r")" = 0x1 ] || die "$sig reverted: $(jq -r .transactionHash <<<"$r")"
    LAST_TX=$(jq -r .transactionHash <<<"$r")
    log "sent $sig as $role on $chain: $LAST_TX"
  else
    cast call "$to" "$sig" "$@" --from "$(cast wallet address "${KS[@]}")" --rpc-url "$rpc" >/dev/null \
      || die "dry run: $sig would revert"
    log "dry run ok: $sig as $role on $chain (not sent)"
  fi
}

# --- wiring.json -------------------------------------------------------------------------------------------------
wiring_path() { echo "$DEPLOY_DIR/$WIRING_FILE"; }
wiring_update() { # wiring_update <jq filter> [jq args...]; only when sending
  [ "$SEND" = 1 ] || return 0
  local f; f=$(wiring_path)
  [ -f "$f" ] || echo '{"version":1,"contracts":{},"peers":{},"extraArgs":{},"link":{},"feePoolWei":null,"association":null,"sourcify":{},"lock":{},"steps":[]}' > "$f"
  local t; t=$(mktemp "$DEPLOY_DIR/.wiring.XXXXXX")
  jq "$@" "$f" > "$t" && chmod 644 "$t" && mv "$t" "$f"
}
# When the file's contracts are not the deployed ones (a replacement deployment), its earlier rows describe the
# old contracts: mark them retired, with the old address, and keep them. Hedera rows go with claims and vault,
# Arbitrum rows with the case, and an Arbitrum row that names the old claims (the case's setPeer) goes too.
wiring_retire_moved() {
  wiring_update --arg c "$CLAIMS" --arg v "$VAULT" --arg k "$CASE" '
    def lc: ascii_downcase;
    (.contracts.claims // "") as $oc | (.contracts.vault // "") as $ov | (.contracts.case // "") as $ok
    | (($oc != "" and ($oc|lc) != ($c|lc)) or ($ov != "" and ($ov|lc) != ($v|lc))) as $hmoved
    | ($ok != "" and ($ok|lc) != ($k|lc)) as $amoved
    | .steps = ((.steps // []) | map(
        if (.retired // false) then .
        elif $hmoved and (.chain == "hedera" or ($oc != "" and ((.call + " " + .result)|lc|contains($oc|lc)))) then
          . + {retired: true, retiredNote: ("recorded against the earlier Hedera deployment, claims " + $oc + " and vault " + $ov)}
        elif $amoved and .chain == "arbitrum" then
          . + {retired: true, retiredNote: ("recorded against the earlier RecourseCase " + $ok)}
        else . end))'
}
# wiring_step <id> <chain> <call> <fromRole> <tx> <result>
wiring_step() {
  wiring_retire_moved
  wiring_update --arg id "$1" --arg chain "$2" --arg call "$3" --arg role "$4" --arg tx "$5" --arg res "$6" \
    --arg at "$(date -u +%FT%TZ)" --arg by "${USER:-ops}" --arg c "$CLAIMS" --arg v "$VAULT" --arg k "$CASE" \
    '.contracts = {claims:$c, vault:$v, case:$k}
     | .steps += [{id:$id, chain:$chain, call:$call, fromRole:$role, tx:$tx, at:$at, result:$res, by:$by}]'
}
