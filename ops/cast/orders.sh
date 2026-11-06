#!/usr/bin/env bash
# The demo cast's planned orders (ops/cast/cast.json), each through the agent's live-order with an
# in-process shop (--local-shop), or its order command and then the shop's pack command (below), with
# the identities' own keys, party selectors, catalogue, spend limits and state folders. Dry by
# default: the commands' own dry runs (live-order's account and topic checks; the 402, the approval
# text and how the spend limits decide it); nothing is written or paid.
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
# An order with "shopMode": "port" runs without --local-shop, against its shop started as its own
# process on its registered port for the length of the command (see with_shop); the agent finds it
# through the shop's ERC-8004 registration, or through SHOP_BASE_URL (that port) while the registry
# cannot be read.
#
# live-order states what the buyer asked for and what arrived (asked Northwind, M, Navy, up to 2.00;
# arrived the staged fault size, else L), which suits the Kestrel claim orders. An order with "via":
# "order" goes through the agent's order command instead, with its own asked values from cast.json,
# and then the shop's pack command (see order_then_pack), so its records state what its buyer asked
# for. A live-order order whose planned asked or arrived differs from live-order's is skipped.
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

port_of() { jq -r --arg s "$(jq -r .shop <<<"$1")" '.shops[] | select(.id == $s) | .port' "$CAST"; }

# run_with <order json> <command...>: the command with the order's env, without the public shop URL
# (the in-process shop has none). For a shop on its port, SHOP_BASE_URL is that port: the agent uses
# it only when the shop's registration cannot be read, and pays the party map's shop either way.
run_with() {
  local o=$1; shift
  local -a assign=()
  mapfile -t assign < <(env_for "$o")
  [ "$(jq -r '.shopMode // "local"' <<<"$o")" != port ] || assign+=("SHOP_BASE_URL=http://127.0.0.1:$(port_of "$o")")
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

# with_shop <order json> <command...>: the command while the order's shop runs as its own process
# (the shop service's code with the shop's env) on the port its registration names. For an order
# with shopMode "port": the agent journals the shop URL of its first 402 and pays to it, so an order
# paid on a later run (after a buyer's approval) needs the shop at the same URL then, which an
# in-process shop on a random port is not. Stops the shop afterwards; the shop's journals stay in
# its state folder.
SHOP_UP=0
with_shop() {
  local o=$1; shift
  if [ "$SHOP_UP" = 1 ]; then "$@"; return $?; fi
  local shop port pid code=0 _
  shop=$(jq -r .shop <<<"$o"); port=$(port_of "$o")
  local health=http://127.0.0.1:$port/health
  if curl -fs -m 2 "$health" >/dev/null 2>&1; then die "port $port already answers: is a $shop shop running already?"; fi
  local -a assign=()
  mapfile -t assign < <(env_for "$o")
  (cd "$ROOT/services/shop" && exec env -u SHOP_PUBLIC_URL -u SHOP_BASE_URL "${assign[@]}" SHOP_PORT="$port" node --import tsx src/main.ts) >>"$STATE/$shop/shop.log" 2>&1 &
  pid=$!
  # An interrupt, or a die inside the command, stops the shop too, so its port is free for the next run.
  trap "kill $pid 2>/dev/null || true" EXIT
  trap "kill $pid 2>/dev/null || true; exit 130" INT TERM
  for _ in $(seq 1 60); do curl -fs -m 2 "$health" >/dev/null 2>&1 && break; sleep 1; done
  if ! curl -fs -m 2 "$health" >/dev/null 2>&1; then
    kill "$pid" 2>/dev/null || true
    die "the $shop shop did not answer on port $port; see $STATE/$shop/shop.log"
  fi
  echo "  $shop shop on port $port (pid $pid)"
  # live-order reads a running shop's journals only from a folder that shop has written.
  [ -f "$STATE/$shop/shop/journal.jsonl" ] || : > "$STATE/$shop/shop/journal.jsonl"
  SHOP_UP=1
  set +e; "$@"; code=$?; set -e
  SHOP_UP=0
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  trap - EXIT INT TERM
  return "$code"
}

live_order() { # live_order <order json> [extra args]
  local o=$1; shift
  local id sku through fault saved log mode
  id=$(jq -r .id <<<"$o"); sku=$(jq -r .sku <<<"$o"); through=$(jq -r .through <<<"$o"); fault=$(jq -r '.fault // empty' <<<"$o")
  mode=$(jq -r '.shopMode // "local"' <<<"$o")
  mkdir -p "$STATE/orders"; saved=$STATE/orders/$id.order; log=$STATE/orders/$id.log
  local -a args=(--sku "$sku" --through "$through")
  [ "$mode" = port ] || args=(--local-shop "${args[@]}")
  [ -z "$fault" ] || args+=(--fault "$fault")
  [ ! -s "$saved" ] || args+=(--order "$(cat "$saved")")
  [ "$SEND" = 0 ] || args+=(--send)
  echo "  live-order ${args[*]}"
  set +e
  if [ "$mode" = port ]; then
    with_shop "$o" run_with "$o" pnpm --silent --filter @recourse/agent live-order "${args[@]}" "$@" 2>&1 | tee -a "$log"
  else
    run_with "$o" pnpm --silent --filter @recourse/agent live-order "${args[@]}" "$@" 2>&1 | tee -a "$log"
  fi
  local code=${PIPESTATUS[0]}
  set -e
  local got; got=$(grep -o '^order 0x[0-9a-f]\{64\}' "$log" | tail -1 | awk '{print $2}' || true)
  [ -z "$got" ] || [ -s "$saved" ] || echo "$got" > "$saved"
  return "$code"
}

order_args() { # order_args <order json>: the agent's order flags for it, one per line: the item and what its buyer asked for
  local o=$1
  jq -r --arg m "$(jq -r --arg s "$(jq -r .shop <<<"$o")" '.shops[] | select(.id == $s) | .name' "$CAST")" \
    '"--sku", .sku, (.asked | to_entries[] | "--\(.key)", .value), "--merchant", $m' <<<"$o"
}

# order_then_pack <order json>: an order with "via": "order", while its shop runs on its port. The
# agent's order command places it with the buyer's asked values from cast.json (a rerun carries the
# saved order on with --resume); once it is paid, the shop's pack command writes the packed record:
# the catalogue item and the price charged. An order that waits for the buyer stops before packing.
order_then_pack() {
  local o=$1
  local id saved log out code
  id=$(jq -r .id <<<"$o")
  mkdir -p "$STATE/orders"; saved=$STATE/orders/$id.order; log=$STATE/orders/$id.log; out=$STATE/orders/$id.last
  local -a args=()
  if [ -s "$saved" ]; then args=(--resume "$(cat "$saved")"); else mapfile -t args < <(order_args "$o"); fi
  [ "$SEND" = 0 ] || args+=(--send)
  echo "  order $(printf '%q ' "${args[@]}")"
  set +e
  run_with "$o" pnpm --silent --filter @recourse/agent order "${args[@]}" 2>&1 | tee "$out"
  code=${PIPESTATUS[0]}
  set -e
  cat "$out" >> "$log"
  local got; got=$(grep -o '^order 0x[0-9a-f]\{64\}' "$out" | tail -1 | awk '{print $2}' || true)
  [ -z "$got" ] || [ -s "$saved" ] || echo "$got" > "$saved"
  [ "$code" = 0 ] || return "$code"
  if [ ! -s "$saved" ]; then echo "  then: the shop's pack --order <the order id> once it is paid"; return 0; fi
  if [ "$SEND" = 1 ] && ! grep -q '"state":"done"' "$out"; then
    grep -q '"state":"awaiting_approval"' "$out" && echo "  waiting for the buyer: orders.sh approve $id --send"
    return 0
  fi
  local -a pargs=(--order "$(cat "$saved")"); [ "$SEND" = 0 ] || pargs+=(--send)
  echo "  pack ${pargs[*]}"
  set +e
  run_with "$o" pnpm --silent --filter @recourse/shop run pack "${pargs[@]}" 2>&1 | tee -a "$log"
  code=${PIPESTATUS[0]}
  set -e
  # A dry run's pack reads the shop's journal only: an order not paid yet is not a failure there.
  [ "$SEND" = 0 ] || return "$code"
}

if [ "$CMD" = approve ]; then
  [ ${#NAMES[@]} = 1 ] || die "usage: orders.sh approve <order id> [--send]"
  o=$(order "${NAMES[0]}"); [ -n "$o" ] || die "no order ${NAMES[0]} in cast.json"
  ready "$o" || exit 2
  log=$STATE/orders/${NAMES[0]}.log
  aid=$([ -f "$log" ] && grep -o 'approve [0-9a-f]\{16\}\b' "$log" | tail -1 | awk '{print $2}' || true)
  [ -n "$aid" ] || die "no approval waiting for ${NAMES[0]}: run orders.sh --send ${NAMES[0]} first"
  if [ "$SEND" = 0 ]; then run_with "$o" pnpm --silent --filter @recourse/agent approve "$aid"; exit $?; fi
  [ "$(jq -r '.shopMode // "local"' <<<"$o")" = port ] || die "${NAMES[0]} ran on an in-process shop, which is gone: its payment URL cannot be reached again"
  # approve signs and journals the decision and pays the shop at the URL of the first 402; the
  # order's own command, rerun, then carries it on to its last step.
  approve_and_finish() {
    run_with "$o" pnpm --silent --filter @recourse/agent approve "$aid" --yes || return $?
    if [ "$(jq -r '.via // "live-order"' <<<"$o")" = order ]; then order_then_pack "$o"; else live_order "$o"; fi
  }
  with_shop "$o" approve_and_finish
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
[ "$SEND" = 1 ] || echo "# dry run: each order's own dry run (live-order, or order then pack); nothing is written or paid; add --send to run them"
failed=()
for name in "${NAMES[@]}"; do
  o=$(order "$name"); [ -n "$o" ] || die "no order $name in cast.json"
  echo "== $name: $(jq -r '"\(.company) buys \(.sku) from \(.shop) -> \(.outcome)"' <<<"$o")"
  via=$(jq -r '.via // "live-order"' <<<"$o")
  if [ "$via" = live-order ] && ! states_honestly "$o"; then
    echo "  skipped: live-order records asked $(jq -c . <<<"$LIVE_ASKED") and arrived Northwind/Navy; this order's buyer asked $(jq -c .asked <<<"$o"), so its records would misstate it"
    continue
  fi
  if ! ready "$o"; then
    if [ "$SEND" = 0 ]; then
      if [ "$via" = order ]; then
        mapfile -t oargs < <(order_args "$o")
        echo "  would run, with the $(jq -r .shop <<<"$o") shop on its port $(port_of "$o"): order $(printf '%q ' "${oargs[@]}"), then the shop's pack --order <the order id> once it is paid"
      else
        echo "  would run: live-order $(jq -r 'if .shopMode == "port" then "(shop on its port \(.shop))" else "--local-shop" end' <<<"$o") --sku $(jq -r .sku <<<"$o") --through $(jq -r .through <<<"$o")$(jq -r 'if .fault then " --fault \(.fault)" else "" end' <<<"$o")"
      fi
      echo "  with: $(env_for "$o" | grep -v '_ADDRESS=$' | tr '\n' ' ')"
    else failed+=("$name"); fi
    continue
  fi
  if [ "$via" = order ]; then
    with_shop "$o" order_then_pack "$o" || failed+=("$name")
  else
    live_order "$o" || failed+=("$name")
  fi
done
[ ${#failed[@]} = 0 ] || { echo "orders.sh: not finished: ${failed[*]}"; exit 1; }
