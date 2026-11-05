#!/usr/bin/env bash
# Read each existing Hedera role's account id (absent roles are skipped with a note) from the mirror node (looked up by EVM address, and the
# mirror's evm_address must equal the address in addresses.txt), then write
#   - HEDERA_ACCOUNT_IDS=role=0.0.N,... into the env file (default ~/.config/recourse/recourse.env)
#   - deployments/parties.json in the shape @recourse/shared parseParties accepts
# Existing agentId values in parties.json are kept (they are added later by identity registration).
# Read-only on chain. Usage: 05-write-ids.sh [--write]   (without --write it prints both)
source "$(dirname "$0")/lib.sh"; need_tools
WRITE=0; for a in "$@"; do [[ $a == --write ]] && WRITE=1; done
PARTIES_OUT=${PARTIES_OUT:-$REPO_ROOT/deployments/parties.json}

write_env() {
  mkdir -p "$(dirname "$ENV_FILE")"; touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  grep -v '^HEDERA_ACCOUNT_IDS=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
  echo "HEDERA_ACCOUNT_IDS=$ids" >> "$ENV_FILE.tmp"; chmod 600 "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "updated HEDERA_ACCOUNT_IDS in $ENV_FILE"
}

declare -A NAME=(
  [deployer]="Recourse Deployer" [ops-hedera]="Recourse Operations Hedera" [ops-arb]="Recourse Operations Arbitrum"
  [precheck-signer]="Recourse Pre-check" [platform]="Parcel Minds" [agent]="Parcel Minds Shopping Agent"
  [shop]="Halden Supply" [scheme]="Recourse Docket" [buyer]="Demo Buyer" [facilitator]="Recourse Payment Relay"
)

declare -A ID
missing=()
for role in "${HEDERA_ROLES[@]}"; do
  j=$(mirror_account "$role"); id=$(jq -r '.account // empty' <<<"$j")
  if [[ -z $id ]]; then echo "note: $role has no account on the mirror yet; left out" >&2; missing+=("$role"); continue; fi
  want=$(addr "$role"); got=$(jq -r '.evm_address // empty' <<<"$j")
  if [[ ${got,,} != "${want,,}" ]]; then echo "note: $role: mirror evm_address $got differs from $want; left out" >&2; missing+=("$role"); continue; fi
  if [[ $(jq -r '.key._type // empty' <<<"$j") != ECDSA_SECP256K1 || -z $(jq -r '.alias // empty' <<<"$j") ]]; then
    echo "warning: $role ($id) is hollow or has no EVM alias; complete it with 01-complete-hedera.sh" >&2
  fi
  ID[$role]=$id
done
if [[ ${#ID[@]} == 0 ]]; then echo "no Hedera account exists yet; nothing to write" >&2; exit 1; fi

ids=""; for role in "${HEDERA_ROLES[@]}"; do [[ -n ${ID[$role]:-} ]] && ids+="${ids:+,}$role=${ID[$role]}"; done
echo "HEDERA_ACCOUNT_IDS=$ids"
PARTIAL=0; [[ ${#missing[@]} -gt 0 ]] && PARTIAL=1
if [[ $PARTIAL == 1 ]]; then
  echo "partial: ${missing[*]} absent. deployments/parties.json needs every Hedera role, so it is not written until they exist." >&2
fi

if [[ $PARTIAL == 1 ]]; then
  if [[ $WRITE == 1 ]]; then write_env; fi
  exit 0
fi
existing='[]'; [[ -f $PARTIES_OUT ]] && existing=$(cat "$PARTIES_OUT")
parties='[]'
for role in "${ALL_ROLES[@]}"; do
  writers='[]'
  case $role in platform) writers=$(jq -nc --arg a "${ID[agent]}" '[$a]');; shop) writers=$(jq -nc --arg a "${ID[shop]}" '[$a]');; esac
  parties=$(jq -c --arg role "$role" --arg evm "$(addr "$role")" --arg id "${ID[$role]:-}" --arg name "${NAME[$role]}" \
    --argjson writers "$writers" --argjson old "$existing" '
    . + [ ({role:$role, evmAddress:$evm, hcsWriters:$writers, displayName:$name}
          + (if $id != "" then {hederaAccountId:$id} else {} end)
          + ((($old | map(select(.role==$role)) | .[0].agentId) // null) as $ag | if $ag != null then {agentId:$ag} else {} end)) ]' <<<"$parties")
done
jq . <<<"$parties" > "${TMPDIR:-/tmp}/parties.$$.json"
if [[ $WRITE == 1 ]]; then
  mkdir -p "$(dirname "$PARTIES_OUT")"; mv "${TMPDIR:-/tmp}/parties.$$.json" "$PARTIES_OUT"; echo "wrote $PARTIES_OUT"
  write_env
  if [[ -x $REPO_ROOT/node_modules/.bin/tsx && -f $REPO_ROOT/packages/shared/src/parties.ts ]]; then
    echo "validate with parseParties: (cd $REPO_ROOT && node --import tsx -e \"…\") — run by hand once dependencies are installed"
  fi
else cat "${TMPDIR:-/tmp}/parties.$$.json"; rm -f "${TMPDIR:-/tmp}/parties.$$.json"; fi
