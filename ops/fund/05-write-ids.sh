#!/usr/bin/env bash
# Read each existing Hedera role's account id (absent roles are skipped with a note) from the mirror node (looked up by EVM address, and the
# mirror's evm_address must equal the address in addresses.txt), then write
#   - HEDERA_ACCOUNT_IDS=role=0.0.N,... into the env file (default ~/.config/recourse/recourse.env)
#   - deployments/parties.json in the shape @recourse/shared parseParties accepts: every role in
#     addresses.txt, with hederaAccountId only for the roles that have an account
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
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "partial: ${missing[*]} absent; their parties.json entries have no hederaAccountId until they exist" >&2
fi

existing='[]'; [[ -f $PARTIES_OUT ]] && existing=$(cat "$PARTIES_OUT")
parties='[]'
for role in "${ALL_ROLES[@]}"; do
  if [[ -z $(addr "$role") ]]; then echo "note: $role is not in $ADDRS_FILE; left out of parties.json" >&2; continue; fi
  writers='[]'
  case $role in
    platform) [[ -n ${ID[agent]:-} ]] && writers=$(jq -nc --arg a "${ID[agent]}" '[$a]');;
    shop) [[ -n ${ID[shop]:-} ]] && writers=$(jq -nc --arg a "${ID[shop]}" '[$a]');;
  esac
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
  if [[ -x $REPO_ROOT/node_modules/.bin/tsx ]]; then
    # The services' own reader: fails, naming the field, if the file is not what they accept.
    (cd "$REPO_ROOT" && PARTIES_FILE="$PARTIES_OUT" node --import tsx --input-type=module -e '
      const { readParties } = await import("./packages/shared/src/node/index.ts");
      const parties = readParties();
      const ids = parties.filter((p) => p.hederaAccountId).map((p) => p.role);
      console.log(`parties.json checked with readParties: ${parties.length} parties, Hedera ids for ${ids.join(", ") || "none"}`);
    ') || { echo "parties.json failed readParties" >&2; exit 1; }
  fi
else cat "${TMPDIR:-/tmp}/parties.$$.json"; rm -f "${TMPDIR:-/tmp}/parties.$$.json"; fi
