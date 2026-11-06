#!/usr/bin/env bash
# Read-only checks of the running services for the test round, and the restart plan the build session runs.
#   ops-checks.sh [check] [--since <journalctl time>]
#       ctl.sh health (text and --json), ctl.sh status, the watch's last runs, the keeper's and the
#       pre-check's alert lines and whether the watch forwarded each one to the notifier (its log is read,
#       never written), the watch's down/back/restarted messages against the same log, and the keeper's
#       gas levels and open intents.
#   ops-checks.sh plan
#       prints the restart plan: one service at a time, each with what to check before and after. It runs
#       nothing; the build session runs each restart line itself.
#   ops-checks.sh after <service> [--wait-s 90]
#       after the build session restarted <service>: waits for it to be up, then checks its unit, health,
#       restart count, memory peak and the journal lines since the restart. Read-only.
# Writes one JSON line per check to $E2E_RAW_DIR/ops-<time>.jsonl and prints the table rows at the end.
# This script restarts, stops and starts nothing, and sends nothing to any notifier.
# Env: RECOURSE_REPO (default: the checkout this file is in), RECOURSE_NOTIFY_LOG (the notifier's log, read
# only; unset: the notifier half of each forwarding row is not checked and the row says so), E2E_RAW_DIR
# (default results/adhoc/raw here).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=${RECOURSE_REPO:-$(cd "$HERE/../.." && pwd)}
CTL="$REPO/ops/units/ctl.sh"
NOTIFY_LOG=${RECOURSE_NOTIFY_LOG:-}
SERVICES=(keeper precheck shop status-api docket intake web)
declare -A PORT=([keeper]=8706 [precheck]=8705 [shop]=8720 [status-api]=8787 [docket]=8707 [intake]=8716 [web]=8788)
declare -A CAP=([keeper]=192 [precheck]=192 [shop]=192 [status-api]=160 [docket]=160 [intake]=160 [web]=48)
RAW=${E2E_RAW_DIR:-$HERE/results/adhoc/raw}
mkdir -p "$RAW"
OUT="$RAW/ops-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
ROWS=()

# row <path> <result> <test> [json data]
row() {
  local data=${4:-null}
  jq -c -n --arg path "$1" --arg result "$2" --arg test "$3" --argjson data "$data" \
    '{t: (now | todate), suite: "ops", path: $path, result: $result, test: $test} + (if $data == null then {} else {data: $data} end)' | tee -a "$OUT"
  ROWS+=("$1 | $2 | $3")
}
table() {
  printf '\n| # | Path | Result | Tx hash or test name |\n|---|---|---|---|\n'
  local i=1 r
  for r in "${ROWS[@]}"; do printf '| %s | %s |\n' "$i" "$r"; i=$((i + 1)); done
  printf '\nresults: %s\n' "$OUT"
}

check() {
  local since=${1:-"-3 hours"}
  # 1. health, as people read it and as the watch reads it.
  local text json rc=0
  text=$(bash "$CTL" health 2>&1) || rc=$?
  printf '%s\n' "$text" >&2
  local down
  down=$(awk 'NR>1 && $1 !~ /^(stray|tunnel-named|  stop)/ && $5 == "down" {print $1}' <<<"$text" | paste -sd, -)
  row "ctl.sh health" "$([ "$rc" = 0 ] && [ -z "$down" ] && echo pass || echo fail)" "every service up${down:+ (down: $down)}"
  json=$(bash "$CTL" health --json 2>/dev/null) || true
  if jq -e '.services | length > 0' >/dev/null 2>&1 <<<"$json"; then
    local summary
    summary=$(jq -c '{up: [.services[] | select(.up) | .service], down: [.services[] | select(.up | not) | .service], errors: [.services[] | select(.errors | length > 0) | "\(.service): \(.errors | join("; ") | .[0:160])"], strays: .strays}' <<<"$json")
    local svc_down
    svc_down=$(jq -r --argjson s "$(printf '%s\n' "${SERVICES[@]}" | jq -R . | jq -s .)" '[.services[] | select((.service as $n | $s | index($n)) and (.up | not)) | .service] | join(",")' <<<"$json")
    row "ctl.sh health --json" "$([ -z "$svc_down" ] && echo pass || echo fail)" "JSON for the watch: one object per unit${svc_down:+, down: $svc_down}" "$summary"
    local strays
    strays=$(jq -c '[.strays[] | select(.allInterfaces)]' <<<"$json")
    if [ "$strays" != "[]" ]; then
      row "ctl.sh health strays" fail "a process of this checkout listens on all interfaces outside the units (public: ufw is off); stop it once known (not done here)" "$strays"
    else
      row "ctl.sh health strays" pass "no process of this checkout listens on all interfaces outside the units"
    fi
  else
    row "ctl.sh health --json" fail "ctl.sh health --json did not give JSON"
  fi
  bash "$CTL" status >&2 || true

  # 2. the watch: timer on, runs every two minutes, no send kept back.
  local timer last journal runs kept nonotifier
  timer=$(systemctl --user is-active recourse-watch.timer 2>/dev/null || true)
  journal=$(journalctl --user -u recourse-watch --since "$since" -o short-iso --no-pager 2>/dev/null || true)
  runs=$(grep -c 'Finished recourse-watch.service' <<<"$journal" || true)
  kept=$(grep -c 'kept for the next run' <<<"$journal" || true)
  nonotifier=$(grep -c 'no usable notifier' <<<"$journal" || true)
  last=$(grep 'Finished recourse-watch.service' <<<"$journal" | tail -1 | awk '{print $1}')
  local age=999999
  [ -z "$last" ] || age=$(( $(date +%s) - $(date -d "$last" +%s) ))
  row "recourse-watch runs" "$([ "$timer" = active ] && [ "$age" -le 180 ] && [ "$kept" = 0 ] && [ "$nonotifier" = 0 ] && echo pass || echo fail)" \
    "timer $timer, $runs runs since $since, last ${age}s ago, $kept sends kept back, $nonotifier without a notifier" \
    "$(jq -n -c --arg last "$last" --argjson runs "${runs:-0}" --argjson kept "${kept:-0}" '{lastRun: $last, runs: $runs, kept: $kept}')"

  # 3. alerts: every keeper and pre-check alert line since the watch's first run, forwarded and in the notifier's log.
  local first_run unit lines n fwd logged missing
  first_run=$(journalctl --user -u recourse-watch -o short-iso --no-pager 2>/dev/null | grep 'first run: recorded' | tail -1 | awk '{print $1}')
  for unit in keeper precheck; do
    lines=$(journalctl --user -u "recourse-$unit" --since "${first_run:-$since}" -o cat --no-pager 2>/dev/null | grep -E '^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z )?alert ' || true)
    # The notifier's lines for this unit's alerts, as "<epoch> <kind>"; each alert takes its own line, sent
    # within 15 minutes after it (the watch runs every 2), so two alerts of a kind need two lines.
    local -a sent_at=() sent_kind=() used=()
    if [ -r "$NOTIFY_LOG" ]; then
      while IFS=$'\t' read -r at title text _; do
        [ "$title" = "recourse $unit alert" ] || continue
        sent_at+=("$(date -d "$at" +%s 2>/dev/null || echo 0)")
        sent_kind+=("${text%%:*}")
        used+=(0)
      done <"$NOTIFY_LOG"
    fi
    n=0 fwd=0 logged=0 missing=()
    while IFS= read -r l; do
      [ -n "$l" ] || continue
      n=$((n + 1))
      local kind at j
      kind=$(sed -E 's/^([0-9T:.Z-]+ )?alert ([a-z_]+).*/\2/' <<<"$l")
      at=$(date -d "$(awk '{print $1}' <<<"$l")" +%s 2>/dev/null || echo "")
      if grep -q "sent: recourse $unit alert: $kind" <<<"$(journalctl --user -u recourse-watch --since "${first_run:-$since}" -o cat --no-pager 2>/dev/null)"; then fwd=$((fwd + 1)); else missing+=("$kind"); fi
      for j in "${!sent_at[@]}"; do
        [ "${used[$j]}" = 0 ] && [ "${sent_kind[$j]}" = "$kind" ] || continue
        # An alert line without its own time can only be matched by kind.
        if [ -z "$at" ] || { [ "${sent_at[$j]}" -ge "$at" ] && [ "${sent_at[$j]}" -le $((at + 900)) ]; }; then used[$j]=1; logged=$((logged + 1)); break; fi
      done
    done <<<"$lines"
    if [ -z "$NOTIFY_LOG" ]; then
      # The watch's half is still read from its journal; a missing forward fails without the notifier's log.
      row "recourse-$unit alerts -> watch -> notifier" "$([ "$n" = "$fwd" ] && echo blocked || echo fail)" \
        "not checked: RECOURSE_NOTIFY_LOG unset ($n alert lines since the watch's first run (${first_run:-none}), $fwd forwarded by the watch${missing:+; not forwarded yet: ${missing[*]}})"
      continue
    fi
    row "recourse-$unit alerts -> watch -> notifier" "$([ "$n" = "$fwd" ] && [ "$n" = "$logged" ] && echo pass || echo fail)" \
      "$n alert lines since the watch's first run (${first_run:-none}), $fwd forwarded by the watch, $logged in the notifier's log${missing:+; not forwarded yet: ${missing[*]}}"
  done
  local before
  before=$(journalctl --user -u recourse-keeper --since "$since" --until "${first_run:-now}" -o cat --no-pager 2>/dev/null | grep -cE '^([0-9T:.Z-]+ )?alert ' || true)
  [ "${before:-0}" = 0 ] || row "recourse-keeper alerts before the watch started" pass "$before alert lines before the first run; not forwarded, by design (the first run only records the journal's end)"

  # 4. the watch's own service messages (down, back, restarted) against the notifier's log.
  local sent matched=0 total=0 title
  sent=$(journalctl --user -u recourse-watch --since "$since" -o cat --no-pager 2>/dev/null | grep -E '^watch: sent: recourse [a-z-]+ (down|back|restarted):' || true)
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    total=$((total + 1))
    title=$(sed -E 's/^watch: sent: (recourse [a-z-]+ (down|back|restarted)):.*/\1/' <<<"$l")
    if [ -r "$NOTIFY_LOG" ] && awk -F'\t' -v t="$title" '$2 == t {f=1} END {exit !f}' "$NOTIFY_LOG"; then matched=$((matched + 1)); fi
  done <<<"$sent"
  if [ -z "$NOTIFY_LOG" ]; then
    row "recourse-watch down/back -> notifier" blocked "not checked: RECOURSE_NOTIFY_LOG unset ($total down/back/restarted messages sent by the watch since $since)"
  else
    row "recourse-watch down/back -> notifier" "$([ "$total" = "$matched" ] && echo pass || echo fail)" "$total down/back/restarted messages sent since $since, $matched in the notifier's log"
  fi

  # 5. the keeper: open intents and the gas it signs with.
  local kh
  kh=$(curl -s -m 10 "http://127.0.0.1:${PORT[keeper]}/health" || true)
  if jq -e . >/dev/null 2>&1 <<<"$kh" && ! jq -e '.levels.opsHederaWeibar and .levels.opsArbWei' >/dev/null 2>&1 <<<"$kh"; then
    # Right after a restart the keeper has not read its balances yet: that is not a balance of zero.
    row "keeper gas and intents" blocked "the keeper has not read its balances yet (levels null, as after a restart); $(jq -r '.openIntents | length' <<<"$kh") open intents" \
      "$(jq -c '{levels, openIntents: (.openIntents | length), problems}' <<<"$kh")"
  elif jq -e . >/dev/null 2>&1 <<<"$kh"; then
    local hbar arb intents problems
    hbar=$(jq -r '.levels.opsHederaWeibar // "0"' <<<"$kh")
    arb=$(jq -r '.levels.opsArbWei // "0"' <<<"$kh")
    intents=$(jq -r '.openIntents | length' <<<"$kh")
    problems=$(jq -c '.problems // []' <<<"$kh")
    local hb
    hb=$(awk -v w="$hbar" 'BEGIN {printf "%.4f", w / 1e18}')
    row "keeper gas and intents" "$(awk -v w="$hbar" 'BEGIN {exit !(w >= 10e18)}' && [ "$intents" = 0 ] && echo pass || echo fail)" \
      "ops-hedera $hb HBAR (floor 10), ops-arb $(awk -v w="$arb" 'BEGIN {printf "%.5f", w / 1e18}') ETH, $intents open intents, problems $problems" \
      "$(jq -c '{levels, openIntents: (.openIntents | length), claimsByPhase, problems, paused, windowsActive}' <<<"$kh")"
  else
    row "keeper gas and intents" blocked "keeper /health did not answer JSON"
  fi
}

plan() {
  cat <<'EOF'
Restart plan for the build session: one service at a time, least state first, keeper last. This script runs
none of it (ops/e2e/run.sh --restarts runs it). After each restart line, run `ops-checks.sh after <service>`
and go on only when it passes.

0. Before any restart:
   bash ops/units/ctl.sh health                      # every service up
   bash ops/units/ctl.sh keeper status               # note openIntents and claimsByPhase
   bash ops/e2e/ops-checks.sh check                  # alerts forwarded, gas levels
   Not during a claim's contest window or within 10 minutes of any claim deadline (the claim's `deadline` in
   GET /api/v1/claims), and not while an order is being paid.

1. web           bash ops/units/ctl.sh restart web
   Before: nothing (static files and the /api proxy; pages reload on their own).
   After:  ops-checks.sh after web; curl -s http://127.0.0.1:8788/health is {"ok":true}; the home page loads.

2. intake        bash ops/units/ctl.sh restart intake
   Before: nothing pending (it only tags feedback text; llmStatus disabled on this host).

3. docket        bash ops/units/ctl.sh restart docket
   Before: curl -s http://127.0.0.1:8707/health shows failedWrites 0. Its cursors resume after the restart.

4. status-api    bash ops/units/ctl.sh restart status-api
   Before: no UI or agent action in progress (a build in flight gets 502 from the web server).
   After:  ops-checks.sh after status-api; GET /api/v1/health shows rebuilding false and each source's lagS
           falling; the watch may report "status-api down" then "back" if a run falls inside the gap
           (14:36/14:38 today); that pair is the down/back test.

5. precheck      bash ops/units/ctl.sh restart precheck
   Before: curl -s http://127.0.0.1:8705/health shows queue 0 (no claim Filed and waiting for its finding).
           A restart with a claim waiting delays its finding; the claim timeout runs from filing.

6. shop          bash ops/units/ctl.sh restart shop
   Before: no x402 order being paid (live-order not running); curl -s http://127.0.0.1:8720/health has
           lastError null. Do not restart tunnel-shop: its public name would change.

7. keeper        bash ops/units/ctl.sh restart keeper
   Before: bash ops/units/ctl.sh keeper status shows openIntents [] (no transaction signed and unresolved),
           no claim within 10 minutes of its deadline, and no relay or settle due (claimsByPhase only
           Closed/Settled, or the next step not due for 10 minutes). Last, because it sends on both chains.
   After:  ops-checks.sh after keeper; /health problems [] once a tick has run (params readable);
           keeper status shows the same claimsByPhase as before.

Never: the tunnels (tunnel-web, tunnel-shop: a restart changes the public names), `ctl.sh restart` with no
service (it restarts all of them at once), or a restart while ops-checks.sh after <previous> is failing.
Watch check without a restart: a manual restart does not raise NRestarts, so the watch's "restarted" message
is not expected; "down"/"back" only shows when a watch run (every 2 minutes) falls inside the gap.
EOF
}

after() {
  local s=${1:?service} wait_s=${2:-90}
  [ -n "${PORT[$s]:-}" ] || { echo "after: one of ${SERVICES[*]}" >&2; exit 2; }
  local end=$(( $(date +%s) + wait_s )) code=000 state
  while :; do
    state=$(systemctl --user is-active "recourse-$s" 2>/dev/null || true)
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT[$s]}/health" || true)
    [ "$state" = active ] && [ "$code" = 200 ] && break
    [ "$(date +%s)" -lt "$end" ] || break
    sleep 3
  done
  local since peak restarts result
  since=$(systemctl --user show "recourse-$s" -p ActiveEnterTimestamp --value)
  peak=$(systemctl --user show "recourse-$s" -p MemoryPeak --value 2>/dev/null || echo "")
  restarts=$(systemctl --user show "recourse-$s" -p NRestarts --value)
  local mb=-1
  [[ "$peak" =~ ^[0-9]+$ ]] && mb=$((peak / 1048576))
  local errs
  errs=$(journalctl --user -u "recourse-$s" --since "$since" -o cat --no-pager 2>/dev/null | grep -ciE 'error|failed|uncaught' || true)
  result=pass
  [ "$state" = active ] && [ "$code" = 200 ] || result=fail
  [ "$mb" -lt "${CAP[$s]}" ] || result=fail
  # An unreadable peak (-1) is under any cap: the cap was not checked, so the row cannot pass.
  [ "$mb" -ge 0 ] || [ "$result" = fail ] || result=blocked
  row "restart $s" "$result" "unit $state, /health $code, since $since, NRestarts $restarts, memory peak ${mb} MB (cap ${CAP[$s]}M), $errs error lines since start" \
    "$(jq -n -c --arg since "$since" --argjson mb "$mb" --argjson errs "${errs:-0}" --arg restarts "$restarts" '{since: $since, memoryPeakMB: $mb, errorLines: $errs, nRestarts: $restarts}')"
}

cmd=${1:-check}
shift || true
case "$cmd" in
  check)
    since="-3 hours"
    if [ "${1:-}" = --since ]; then since=${2:?time}; fi
    check "$since"; table ;;
  plan) plan ;;
  after)
    svc=${1:?service}; shift
    w=90
    if [ "${1:-}" = --wait-s ]; then w=${2:?seconds}; fi
    after "$svc" "$w"; table ;;
  *) sed -n '2,/^set -/p' "$0" | sed '$d'; exit 1 ;;
esac
