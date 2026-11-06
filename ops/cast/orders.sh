#!/usr/bin/env bash
# The demo cast's planned orders (ops/cast/cast.json), each through the agent's live-order with an
# in-process shop (--local-shop) and the identities' own keys, party selectors, catalogue, spend
# limits and state folders. Dry by default: live-order's own dry run (account and topic checks, the
# 402, the approval text and how the spend limits decide it); nothing is written or paid.
#
#   ops/cast/orders.sh [--send] [<order id>...]      every planned order, or the ones named
#   ops/cast/orders.sh approve <order id> [--send]   the buyer's approval of an order above the spend
#                                                    limit (without --send: what would be signed), then
#                                                    the rest of that order
#   ops/cast/orders.sh withdraw <order id> [--send]  the order's shop withdraws its vault credit (after a
#                                                    claim that paid it has closed)
#   ops/cast/orders.sh list                          the planned orders and what each is meant to show
#
# Needs recourse.env loaded (set -a; . ~/.config/recourse/recourse.env; set +a) and ops/cast/setup.ts
# --send done: the addresses come from its journal. State: CAST_STATE_DIR (default
# ~/.local/state/recourse/cast): <shop>/shop is a shop's journals, <company>/agent an agent's, and
# orders/<order id>.order the order id live-order printed, so a rerun carries the order on with --order.
#
# live-order states what the buyer asked for and what arrived (asked Northwind, M, Navy, up to 2.00;
# arrived the staged fault size, else L). An order whose planned asked or arrived differs would get
# records that misstate it, so --send skips it until live-order takes them from the order.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CAST=$ROOT/ops/cast/cast.json
STATE=${CAST_STATE_DIR:-$HOME/.local/state/recourse/cast}
KEYS=${KEYSTORE_DIR:-$HOME/.config/recourse/keys}
JOURNAL=$STATE/journal.jsonl
LIVE_ASKED='{"brand":"Northwind","size":"M","colour":"Navy","price":"2.00"}'

die() { echo "orders.sh: $*" >&2; exit 1; }
for t in jq pnpm; do command -v "$t" >/dev/null || die "missing tool: $t"; done

SEND=0; CMD=run; NAMES=()
for a in "$@"; do
  case "$a" in
    --send) SEND=1 ;;
    approve|withdraw|list) [ "$CMD" = run ] && [ ${#NAMES[@]} = 0 ] || die "approve, withdraw and list come first"; CMD=$a ;;
    -*) die "unknown option $a" ;;
    *) NAMES+=("$a") ;;
  esac
done

order() { jq -c --arg id "$1" '.orders[] | select(.id == $id)' "$CAST"; }
address_of() { # address_of <key>: the address setup.ts journaled for that key
  [ -f "$JOURNAL" ] || return 0
  jq -r --arg k "$1" 'select(.key == $k and .address != null) | .address' "$JOURNAL" | tail -1
}

if [ "$CMD" = list ]; then
  jq -r '.orders[] | "\(.id): \(.company) buys \(.sku) from \(.shop), through \(.through)\(if .fault then ", fault \(.fault)" else "" end) -> \(.outcome)\n    \(.shows)"' "$CAST"
  exit 0
fi

# env_for <order json>: prints the env assignments for that order's company and shop, one per line.
env_for() {
  local o=$1 co shop sa pa aa
  co=$(jq -r .company <<<"$o"); shop=$(jq -r .shop <<<"$o")
  sa=$(address_of "cast-$shop"); pa=$(address_of "cast-$co-platform"); aa=$(address_of "cast-$co-agent")
  mkdir -p "$STATE/$shop/shop" "$STATE/$co/agent"
  jq '.shops[] | select(.id == "'"$shop"'") | .catalogue' "$CAST" > "$STATE/$shop/catalogue.json"
  echo "SHOP_KEY_FILE=$KEYS/cast-$shop.json"
  echo "PLATFORM_KEY_FILE=$KEYS/cast-$co-platform.json"
  echo "AGENT_KEY_FILE=$KEYS/cast-$co-agent.json"
  echo "RECOURSE_SHOP_ADDRESS=$sa"
  echo "RECOURSE_PLATFORM_ADDRESS=$pa"
  echo "RECOURSE_AGENT_ADDRESS=$aa"
  echo "SHOP_STATE_DIR=$STATE/$shop/shop"
  echo "AGENT_STATE_DIR=$STATE/$co/agent"
  echo "SHOP_CATALOG_FILE=$STATE/$shop/catalogue.json"
  jq -r '.agentCompanies[] | select(.id == "'"$co"'") | .limits | to_entries[] | "\(.key)=\(.value)"' "$CAST"
}

# run_with <order json> <command...>: the command with the order's env, without the public shop URL
# (the in-process shop has none).
run_with() {
  local o=$1; shift
  local -a assign=()
  mapfile -t assign < <(env_for "$o")
  (cd "$ROOT" && env -u SHOP_PUBLIC_URL -u SHOP_BASE_URL "${assign[@]}" "$@")
}

ready() { # ready <order json>: setup.ts has made every identity the order needs
  local o=$1 co shop k missing=()
  co=$(jq -r .company <<<"$o"); shop=$(jq -r .shop <<<"$o")
  for k in "cast-$shop" "cast-$co-platform" "cast-$co-agent"; do
    [ -n "$(address_of "$k")" ] && [ -f "$KEYS/$k.json" ] || missing+=("$k")
  done
  [ ${#missing[@]} = 0 ] && return 0
  echo "  not ready: ${missing[*]} not made yet (node --import tsx ops/cast/setup.ts --send)"; return 1
}

states_honestly() { # live-order's fixed asked and arrived attributes are this order's own
  local o=$1 fault size
  [ "$(jq -cS .asked <<<"$o")" = "$(jq -cS . <<<"$LIVE_ASKED")" ] || return 1
  fault=$(jq -r '.fault // empty' <<<"$o"); size=${fault#ordered-size=}; [ -n "$fault" ] || size=L
  [ "$(jq -r '.arrived // empty' <<<"$o")" = "" ] || [ "$(jq -cS .arrived <<<"$o")" = "$(jq -cS --arg s "$size" '{brand:"Northwind",size:$s,colour:"Navy"}' <<<'{}')" ] || return 1
}

live_order() { # live_order <order json> [extra args]
  local o=$1; shift
  local id sku through fault saved log
  id=$(jq -r .id <<<"$o"); sku=$(jq -r .sku <<<"$o"); through=$(jq -r .through <<<"$o"); fault=$(jq -r '.fault // empty' <<<"$o")
  mkdir -p "$STATE/orders"; saved=$STATE/orders/$id.order; log=$STATE/orders/$id.log
  local -a args=(--local-shop --sku "$sku" --through "$through")
  [ -z "$fault" ] || args+=(--fault "$fault")
  [ ! -s "$saved" ] || args+=(--order "$(cat "$saved")")
  [ "$SEND" = 0 ] || args+=(--send)
  echo "  live-order ${args[*]}"
  set +e
  run_with "$o" pnpm --silent --filter @recourse/agent live-order "${args[@]}" "$@" 2>&1 | tee -a "$log"
  local code=${PIPESTATUS[0]}
  set -e
  local got; got=$(grep -o '^order 0x[0-9a-f]\{64\}' "$log" | tail -1 | awk '{print $2}' || true)
  [ -z "$got" ] || [ -s "$saved" ] || echo "$got" > "$saved"
  return "$code"
}

if [ "$CMD" = approve ]; then
  [ ${#NAMES[@]} = 1 ] || die "usage: orders.sh approve <order id> [--send]"
  o=$(order "${NAMES[0]}"); [ -n "$o" ] || die "no order ${NAMES[0]} in cast.json"
  ready "$o" || exit 2
  log=$STATE/orders/${NAMES[0]}.log
  aid=$([ -f "$log" ] && grep -o 'approve [0-9a-f]\{16\} --yes' "$log" | tail -1 | awk '{print $2}' || true)
  [ -n "$aid" ] || die "no approval waiting for ${NAMES[0]}: run orders.sh --send ${NAMES[0]} first"
  if [ "$SEND" = 0 ]; then run_with "$o" pnpm --silent --filter @recourse/agent approve "$aid"; exit $?; fi
  # approve signs and journals the decision, then tries to pay through the shop's registered
  # endpoint, where no cast shop listens; the payment is made by the live-order rerun below.
  run_with "$o" pnpm --silent --filter @recourse/agent approve "$aid" --yes || echo "  (approve's own payment attempt failed; the decision is journaled, live-order pays)"
  live_order "$o"
  exit $?
fi

if [ "$CMD" = withdraw ]; then
  [ ${#NAMES[@]} = 1 ] || die "usage: orders.sh withdraw <order id> [--send]"
  o=$(order "${NAMES[0]}"); [ -n "$o" ] || die "no order ${NAMES[0]} in cast.json"
  ready "$o" || exit 2
  args=(--as shop); [ "$SEND" = 0 ] || args+=(--send)
  run_with "$o" pnpm --silent --filter @recourse/agent withdraw-credit "${args[@]}"
  exit $?
fi

[ ${#NAMES[@]} -gt 0 ] || mapfile -t NAMES < <(jq -r '.orders[].id' "$CAST")
[ "$SEND" = 1 ] || echo "# dry run: live-order's dry run for each order; nothing is written or paid; add --send to run them"
failed=()
for name in "${NAMES[@]}"; do
  o=$(order "$name"); [ -n "$o" ] || die "no order $name in cast.json"
  echo "== $name: $(jq -r '"\(.company) buys \(.sku) from \(.shop) -> \(.outcome)"' <<<"$o")"
  if ! states_honestly "$o"; then
    echo "  skipped: live-order records asked $(jq -c . <<<"$LIVE_ASKED") and arrived Northwind/Navy; this order's buyer asked $(jq -c .asked <<<"$o"), so its records would misstate it"
    continue
  fi
  if ! ready "$o"; then
    if [ "$SEND" = 0 ]; then
      echo "  would run: live-order --local-shop --sku $(jq -r .sku <<<"$o") --through $(jq -r .through <<<"$o")$(jq -r 'if .fault then " --fault \(.fault)" else "" end' <<<"$o")"
      echo "  with: $(env_for "$o" | grep -v '_ADDRESS=$' | tr '\n' ' ')"
    else failed+=("$name"); fi
    continue
  fi
  live_order "$o" || failed+=("$name")
done
[ ${#failed[@]} = 0 ] || { echo "orders.sh: not finished: ${failed[*]}"; exit 1; }
