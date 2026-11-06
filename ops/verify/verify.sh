#!/usr/bin/env bash
# Source verification for the contracts in deployments/hedera.json and deployments/arbitrum.json. Sends no
# transaction: it publishes each contract's source to Sourcify (HashScan shows Sourcify's result for Hedera) and, on
# Arbitrum Sepolia, to Arbiscan through Etherscan's v2 API when the key file exists.
#   bash ops/verify/verify.sh [--chain hedera|arbitrum|all] [--dry-run] [--src-dir DIR]
# Each contract is built from the commit its deploy recorded (the CREATE for its address in
# contracts/broadcast/*/<chainId>/run-*.json), in a detached git worktree under the source dir, and the build's
# creation code is compared with the deploy's input before anything is sent; the constructor arguments are what the
# input carries after that code. A contract a verifier already holds is reported, not sent again. --dry-run builds,
# compares and reads the current status, and prints the commands it would run instead of running them.
# Prints a markdown table (chain | contract | address | commit | verifier | status | link); exits 1 when a row failed.
#   RECOURSE_VERIFY_SRC  where the worktrees go (default ${TMPDIR:-/tmp}/recourse-verify-src; --src-dir wins)
#   VERIFY_COMMIT        build every contract from this commit instead of the one its deploy recorded
#   VERIFY_LOCK          run each forge build under flock -w 1800 on this file
#   FOUNDRY_OUT, FOUNDRY_CACHE_PATH  when set, base dirs for each commit's build output and cache
#   ETHERSCAN_KEY_FILE   default ~/.config/recourse/etherscan.key; read here, never printed
#   SOURCIFY_URL         default https://sourcify.dev/server
set -uo pipefail

usage() { echo "usage: verify.sh [--chain hedera|arbitrum|all] [--dry-run] [--src-dir DIR]" >&2; exit 2; }
CHAINS=all; DRY=0; SRC=${RECOURSE_VERIFY_SRC:-${TMPDIR:-/tmp}/recourse-verify-src}
while [ $# -gt 0 ]; do
  case "$1" in
    --chain) [ $# -ge 2 ] || usage; CHAINS=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --src-dir) [ $# -ge 2 ] || usage; SRC=$2; shift 2 ;;
    *) usage ;;
  esac
done
case "$CHAINS" in hedera|arbitrum) ;; all) CHAINS="hedera arbitrum" ;; *) usage ;; esac

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel) || exit 2
SOURCIFY=${SOURCIFY_URL:-https://sourcify.dev/server}; SOURCIFY=${SOURCIFY%/}
KEY_FILE=${ETHERSCAN_KEY_FILE:-$HOME/.config/recourse/etherscan.key}
mkdir -p "$SRC" || exit 2
failed=0
declare -A BUILT=()

say() { echo "verify: $*" >&2; }
# A row's text on one line, without '|', and the Etherscan key cut out wherever a tool echoed it.
clean() {
  local s=${1//$'\n'/ }
  [ -n "${KEY:-}" ] && s=${s//"$KEY"/<key>}
  s=$(printf '%s' "$s" | sed -E 's/(apikey=)[^&[:space:]]*/\1<key>/Ig; s/\|/\//g; s/  */ /g')
  printf '%s' "${s:0:220}"
}
row() { printf '| %s | %s | %s | %s | %s | %s | %s |\n' "$1" "$2" "$3" "$4" "$5" "$(clean "$6")" "$7"; }

# The CREATE that put <address> on <chainId>: "<contractName> <commit> <file>", from the newest run file that has it.
find_create() {
  local f hit
  for f in $(ls -t "$ROOT"/contracts/broadcast/*/"$1"/run-*.json 2>/dev/null); do
    hit=$(jq -r --arg a "${2,,}" '.commit as $c | [.transactions[]
      | select(.transactionType == "CREATE" and ((.contractAddress // "") | ascii_downcase) == $a)][0]
      | select(. != null) | "\(.contractName) \($c // "-")"' "$f" 2>/dev/null)
    [ -n "$hit" ] && { echo "$hit $f"; return 0; }
  done
  return 1
}

# A detached worktree at <commit> under $SRC with the repo's node_modules linked in (the remappings read
# ../node_modules); prints its contracts dir. The main checkout is never touched.
worktree() {
  local sha dir
  sha=$(git -C "$ROOT" rev-parse --verify --quiet "$1^{commit}") || { say "no commit $1 in this clone"; return 1; }
  dir="$SRC/${sha:0:12}"
  if [ ! -d "$dir/contracts" ]; then
    git -C "$ROOT" worktree add -q --detach "$dir" "$sha" >&2 || return 1
  fi
  [ -e "$dir/node_modules" ] || ln -s "$ROOT/node_modules" "$dir/node_modules"
  echo "$dir/contracts"
}

# Each commit's build output and cache: under FOUNDRY_OUT and FOUNDRY_CACHE_PATH when they are set, else in its
# worktree. forge_in runs a command in a worktree's contracts dir with that commit's two dirs.
OUT_BASE=${FOUNDRY_OUT:-}; CACHE_BASE=${FOUNDRY_CACHE_PATH:-}
out_of() { if [ -n "$OUT_BASE" ]; then echo "$OUT_BASE/$(basename "$(dirname "$1")")"; else echo "$1/out"; fi; }
cache_of() { if [ -n "$CACHE_BASE" ]; then echo "$CACHE_BASE/$(basename "$(dirname "$1")")"; else echo "$1/cache"; fi; }
forge_in() { local dir=$1; shift; ( cd "$dir" && FOUNDRY_OUT=$(out_of "$dir") FOUNDRY_CACHE_PATH=$(cache_of "$dir") "$@" ); }

build() {
  [ -n "${BUILT[$1]:-}" ] && return "${BUILT[$1]}"
  say "building $(basename "$(dirname "$1")") (forge build)"
  if forge_in "$1" ${VERIFY_LOCK:+flock -w 1800 "$VERIFY_LOCK"} forge build --skip test --skip script >/dev/null 2>&1
  then BUILT[$1]=0; else BUILT[$1]=1; fi
  return "${BUILT[$1]}"
}

# Compares the build's creation code with the deploy's input: "exact <args>", "partial <args>" (the same code with
# other metadata) or "differs".
compare() { # <input> <compiled code>
  local input=${1,,} code=${2,,} n body
  if [[ "$input" == "$code"* ]]; then echo "exact 0x${input:${#code}}"; return; fi
  n=$(( 16#${code: -4} )); body=${code:0:$(( ${#code} - 2 * (n + 2) ))}
  if [ "$n" -gt 0 ] && [ ${#body} -gt 2 ] && [[ "$input" == "$body"* ]]; then echo "partial 0x${input:${#code}}"; return; fi
  echo differs
}

sourcify_match() { # <chainId> <address> -> exact_match | match | none | unknown
  local r
  r=$(curl -s -m 20 "$SOURCIFY/v2/contract/$1/$2") || { echo unknown; return; }
  printf '%s' "$r" | jq -r 'if has("match") then (.match // "none") else "unknown" end' 2>/dev/null || echo unknown
}
said() { case "$1" in exact_match) echo "verified full (exact_match)" ;; match) echo "verified partial (match)" ;; *) echo "$1" ;; esac; }

# Etherscan v2 getsourcecode; the URL (with the key) goes to curl on stdin, never on its command line.
etherscan_verified() { # <chainId> <address> -> yes | no | unknown
  local r
  r=$(printf 'url = "https://api.etherscan.io/v2/api?chainid=%s&module=contract&action=getsourcecode&address=%s&apikey=%s"\n' \
    "$1" "$2" "$KEY" | curl -s -m 20 -K -) || { echo unknown; return; }
  printf '%s' "$r" | jq -r 'if .status == "1" then (if (.result[0].SourceCode // "") != "" then "yes" else "no" end)
    else "unknown" end' 2>/dev/null || echo unknown
}

# The first line of a tool's output that says what went wrong, else its last line.
why() { local l; l=$(printf '%s\n' "$1" | grep -m1 -iE 'error|fail|unable|cannot|not found|denied' || printf '%s\n' "$1" | tail -1); echo "$l"; }

verify_one() { # <chain name> <chainId> <key> <address>
  local cname=$1 cid=$2 key=$3 addr=$4 create name commit file dir src id out input code cmp args m st link r
  if ! create=$(find_create "$cid" "$addr"); then
    row "$cname" "$key" "$addr" "-" "-" "failed: no CREATE for this address in contracts/broadcast/*/$cid" "-"; failed=1; return
  fi
  read -r name commit file <<<"$create"
  [ "$commit" = - ] && commit=""
  commit=${VERIFY_COMMIT:-$commit}
  [ -n "$commit" ] || { row "$cname" "$key $name" "$addr" "-" "-" "failed: $file records no commit; set VERIFY_COMMIT" "-"; failed=1; return; }
  commit=$(git -C "$ROOT" rev-parse --short "$commit^{commit}" 2>/dev/null || echo "$commit")
  if ! dir=$(worktree "$commit"); then
    row "$cname" "$key $name" "$addr" "$commit" "-" "failed: cannot check out $commit in a worktree" "-"; failed=1; return
  fi
  src=$(cd "$dir" && grep -rlE "^(abstract )?contract $name\b" src | head -2)
  if [ "$(printf '%s\n' "$src" | grep -c .)" != 1 ]; then
    row "$cname" "$key $name" "$addr" "$commit" "-" "failed: no single source file declares contract $name at $commit" "-"; failed=1; return
  fi
  id="$src:$name"
  cmp=differs
  if build "$dir"; then
    out=$(out_of "$dir")
    input=$(jq -r --arg a "${addr,,}" '[.transactions[] | select(.transactionType == "CREATE"
      and ((.contractAddress // "") | ascii_downcase) == $a)][0].transaction.input // ""' "$file")
    code=$(jq -r '.bytecode.object // ""' "$out/$(basename "$src")/$name.json" 2>/dev/null)
    [ -n "$input" ] && [ -n "$code" ] && cmp=$(compare "$input" "$code")
  else
    say "forge build failed in $dir"
  fi
  read -r cmp args <<<"$cmp"
  say "$name at $addr: the build at $commit against the deployed creation code: $cmp"

  # Sourcify (HashScan reads it for Hedera)
  if [ "$cid" = 296 ]; then link="https://hashscan.io/testnet/contract/$addr"; else link="https://repo.sourcify.dev/$cid/$addr"; fi
  m=$(sourcify_match "$cid" "$addr")
  case "$m" in
    exact_match|match) st=$(said "$m") ;;
    *)
      if [ "$cmp" = differs ]; then
        st="failed: the build at $commit differs from the deployed creation code; not sent"; failed=1
      elif [ "$DRY" = 1 ]; then
        st="not verified ($m); dry run, would send"
        say "dry run: (cd $dir && forge verify-contract $addr $id --chain $cid --verifier sourcify --watch)"
      else
        say "sending $name to Sourcify for chain $cid"
        r=$(forge_in "$dir" timeout 600 forge verify-contract "$addr" "$id" --chain "$cid" --verifier sourcify \
          ${SOURCIFY_URL:+--verifier-url "$SOURCIFY/"} --watch 2>&1); local rc=$?
        m=$(sourcify_match "$cid" "$addr")
        case "$m" in
          exact_match|match) st=$(said "$m") ;;
          *) st="failed (exit $rc): $(why "$r")"; failed=1 ;;
        esac
      fi ;;
  esac
  row "$cname" "$key $name" "$addr" "$commit $cmp" "Sourcify" "$st" "$link"

  # Arbiscan, through Etherscan's v2 API
  [ "$cid" = 421614 ] || return 0
  link="https://sepolia.arbiscan.io/address/$addr#code"
  if [ -z "${KEY:-}" ]; then row "$cname" "$key $name" "$addr" "$commit $cmp" "Arbiscan" "Arbiscan pending: no key" "$link"; return; fi
  if [ "$(etherscan_verified "$cid" "$addr")" = yes ]; then
    row "$cname" "$key $name" "$addr" "$commit $cmp" "Arbiscan" "verified" "$link"; return
  fi
  if [ "$cmp" = differs ]; then
    row "$cname" "$key $name" "$addr" "$commit $cmp" "Arbiscan" "failed: the build at $commit differs from the deployed creation code; not sent" "$link"; failed=1; return
  fi
  if [ "$DRY" = 1 ]; then
    say "dry run: (cd $dir && ETHERSCAN_API_KEY=<from $KEY_FILE> forge verify-contract $addr $id --chain $cid --verifier etherscan --constructor-args $args --watch)"
    row "$cname" "$key $name" "$addr" "$commit $cmp" "Arbiscan" "not verified; dry run, would send" "$link"; return
  fi
  say "sending $name to Arbiscan"
  r=$(export ETHERSCAN_API_KEY=$KEY; forge_in "$dir" timeout 600 forge verify-contract "$addr" "$id" --chain "$cid" \
    --verifier etherscan --constructor-args "$args" --watch 2>&1); local rc2=$?
  if [ "$(etherscan_verified "$cid" "$addr")" = yes ] || printf '%s' "$r" | grep -qiE 'already verified|Pass - Verified'; then
    st=verified
  else
    st="failed (exit $rc2): $(why "$r")"; failed=1
  fi
  row "$cname" "$key $name" "$addr" "$commit $cmp" "Arbiscan" "$st" "$link"
}

KEY=""
if [ -r "$KEY_FILE" ]; then KEY=$(tr -d '[:space:]' < "$KEY_FILE"); fi

echo "| chain | contract | address | commit, build | verifier | status | link |"
echo "|---|---|---|---|---|---|---|"
for chain in $CHAINS; do
  rec="$ROOT/deployments/$chain.json"
  [ -r "$rec" ] || { row "$chain" "-" "-" "-" "-" "failed: no $rec" "-"; failed=1; continue; }
  cid=$(jq -r '.chainId' "$rec")
  case "$chain:$cid" in
    hedera:296|arbitrum:421614) ;;
    *) row "$chain" "-" "-" "-" "-" "failed: chainId $cid is not the testnet this script verifies on" "-"; failed=1; continue ;;
  esac
  # Every contract in the record, and the vault token when it is the testnet mock this repo deploys.
  while read -r key addr; do
    [ -n "$addr" ] && [ "$addr" != null ] && verify_one "$chain" "$cid" "$key" "$addr"
  done < <(jq -r '(.contracts // {} | to_entries[] | "\(.key) \(.value.address)"),
    (select(.usdc.mode == "mock") | "usdc \(.usdc.address)")' "$rec")
done
exit "$failed"
