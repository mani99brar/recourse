#!/usr/bin/env bash
# Recourse watch: tells the operator what the services otherwise only write to their logs. Run every two
# minutes by recourse-watch.timer (ops/units); safe to run by hand. One run:
#   1. reads `ctl.sh health --json` and sends a message when a service goes down or comes back, or restarted
#      on its own since the last run (an OOM kill and restart between two runs never shows as down).
#   2. forwards each new "alert ..." line the keeper and the pre-check wrote to the journal since the last run.
#      They POST alerts to ALERT_URL, which is not set on this host, so these lines are where alerts land.
# The first run (no saved state) only records where each journal ends and each service's state; it sends
# nothing, so enabling the timer does not replay old alerts.
# Delivery is at least once. A journal's saved place moves past an alert line only after the notifier took
# it (exit 0), and a service's saved state changes only once its down/back/restarted message went out. A
# notifier that fails or times out, a run that runs out of time, or a run killed part way (the unit's
# TimeoutStartSec, a stop) leaves the rest for the next run; a kill just after a send can repeat that one.
# After the first failed send in a run nothing else is tried until the next run.
# Sending: RECOURSE_NOTIFY_CMD names a command, called as <cmd> "<title>" "<message>"; it must exit non-zero
# when it could not deliver. When it is unset, empty or not executable, each message is only logged (stdout,
# so the unit's journal), counts as handled, and the run still succeeds.
# Time: no send starts after WATCH_BUDGET_S (default 80) seconds from the start of the run, and each send
# gets at most WATCH_SEND_TIMEOUT_S (default 40), cut to what is left of the budget, then 5 s to die.
# What is sent: an alert line's text after "alert ", through ops/watch/redact.jq (a URL keeps only its scheme
# and host; 64-hex runs, JWTs and long tokens are replaced) and cut to 600 characters. A claim id in the
# place the alerter puts it (alert <kind> <claim id>...) is kept as 0x<first 8>…<last 4>, enough to find
# the line in `ctl.sh logs <unit>`. At most WATCH_MAX_SENDS (default 20) alert messages per unit per run; the
# rest are counted in one more message.
# State: WATCH_STATE_DIR (default ~/.local/state/recourse/watch): journal-<unit>.cursor (empty: the journal
# had no line when it was recorded, so read it from its start), health-<service>.
# Tests: WATCH_HEALTH_FILE=<file> reads the health JSON from a file instead of ctl.sh; journalctl is taken
# from PATH.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
STATE=${WATCH_STATE_DIR:-$HOME/.local/state/recourse/watch}
UNITS=${WATCH_ALERT_UNITS:-keeper precheck}
MAX=${WATCH_MAX_SENDS:-20}
BUDGET_MS=$(( ${WATCH_BUDGET_S:-80} * 1000 ))
SEND_MS=$(( ${WATCH_SEND_TIMEOUT_S:-40} * 1000 ))
mkdir -p "$STATE"
exec 9>"$STATE/.lock"
flock -n 9 || { echo "watch: the last run is still going; skipped"; exit 0; }

log() { printf 'watch: %s\n' "$*"; }
now_ms() { local us=${EPOCHREALTIME//[!0-9]/}; echo $((10#$us / 1000)); }
START_MS=$(now_ms)
save() { printf '%s\n' "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"; } # save <file> <line>, never half written
clean() { jq -R -r -L "$HERE" 'include "redact"; redact | .[0:600]'; }
clean_alert() {
  jq -R -r -L "$HERE" 'include "redact";
    (capture("^(?<k>[a-z_]+) 0x(?<a>[0-9a-fA-F]{8})[0-9a-fA-F]{52}(?<z>[0-9a-fA-F]{4})(?<rest>(?![0-9a-fA-F]).*)$") // null) as $m
    | if $m then "\($m.k) 0x\($m.a)…\($m.z)" + ($m.rest | redact) else redact end | .[0:600]'
}

NOTIFIER=""
if [ -n "${RECOURSE_NOTIFY_CMD:-}" ]; then NOTIFIER=$(command -v -- "$RECOURSE_NOTIFY_CMD" 2>/dev/null || true); fi
sent=0 held=0 STOPPED=""
trap 'log "stopped by a signal after $sent message(s); every line not yet sent stays for the next run"; exit 143' TERM INT

# notify <title> <message> (already clean). Exit 0: delivered, or logged only because there is no notifier.
# Exit 1: not delivered (failed, timed out, out of time, or an earlier send failed this run); try again later.
notify() {
  if [ -z "$NOTIFIER" ]; then
    sent=$((sent + 1))
    log "no usable notifier (RECOURSE_NOTIFY_CMD ${RECOURSE_NOTIFY_CMD:+is not an executable command}${RECOURSE_NOTIFY_CMD:-is not set}); logged only: $1: $2"
    return 0
  fi
  [ -z "$STOPPED" ] || return 1
  local left=$((BUDGET_MS - ($(now_ms) - START_MS))) t rc=0
  if [ "$left" -le 0 ]; then STOPPED="the run's ${WATCH_BUDGET_S:-80} s for sending are used up"; return 1; fi
  [ "$left" -lt "$SEND_MS" ] || left=$SEND_MS
  t="$((left / 1000)).$(printf '%03d' $((left % 1000)))"
  timeout -k 5 "$t" "$NOTIFIER" "$1" "$2" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 0 ]; then
    sent=$((sent + 1)); log "sent: $1: $2"; return 0
  fi
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then STOPPED="the notifier did not finish in ${t} s"
  else STOPPED="the notifier failed (exit $rc)"; fi
  log "$STOPPED; kept for the next run: $1: $2"
  return 1
}

# Prints "<cursor>\t<message>" for each line recourse-<unit> wrote after the saved cursor (all of them when
# the saved cursor is empty). Exit 1 when journalctl fails.
journal_rows() {
  local unit=$1 c after=()
  c=$(cat "$2")
  [ -z "$c" ] || after=("--after-cursor=$c")
  journalctl --user -u "recourse-$unit" -o json -a --no-pager -q "${after[@]}" |
    jq -r 'select(.__CURSOR != null) | "\(.__CURSOR)\t\(.MESSAGE | if type == "string" then gsub("[\t\r\n]"; " ") else "" end)"'
}
journal_end() { # the cursor of recourse-<unit>'s last line, empty when it has none
  journalctl --user -u "recourse-$1" -o json -a --no-pager -q -n 1 | jq -r '.__CURSOR // empty'
}

ALERT_RE='^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z )?alert (.*)$' # the keeper stamps its lines; the pre-check does not

forward_unit() {
  local unit=$1 cur="$STATE/journal-$1.cursor" rows c line end
  local keep="" last="" n=0 over=0 left=0
  if [ ! -f "$cur" ]; then
    end=$(journal_end "$unit") || { log "recourse-$unit: journalctl failed; no place recorded yet"; return 0; }
    save "$cur" "$end"; return 0
  fi
  if ! rows=$(journal_rows "$unit" "$cur"); then
    # A saved place journalctl cannot seek to: start again at the journal's end, and say what may be missing.
    end=$(journal_end "$unit") || { log "recourse-$unit: journalctl failed; the saved place is kept"; return 0; }
    save "$cur" "$end"
    log "recourse-$unit: journalctl could not read from the saved place; started again at the journal's end"
    notify "recourse $unit alert" "the watch lost its place in the $unit journal and started again at its end; alerts written before now may not have been sent; see ctl.sh logs $unit" || true
    return 0
  fi
  [ -n "$rows" ] || return 0
  while IFS=$'\t' read -r c line; do
    [ -n "$c" ] || continue
    last=$c
    if [ "$left" -gt 0 ]; then # a send failed: count what waits, move no further
      [[ $line =~ $ALERT_RE ]] && left=$((left + 1))
      continue
    fi
    if ! [[ $line =~ $ALERT_RE ]] || [ -z "${BASH_REMATCH[2]}" ]; then
      [ "$over" -gt 0 ] || keep=$c
      continue
    fi
    n=$((n + 1))
    if [ "$n" -gt "$MAX" ]; then over=$((over + 1)); continue; fi
    if notify "recourse $unit alert" "$(clean_alert <<<"${BASH_REMATCH[2]}")"; then keep=$c; save "$cur" "$c"
    else left=1; fi
  done <<<"$rows"
  if [ "$left" = 0 ] && [ "$over" -gt 0 ]; then
    if notify "recourse $unit alert" "$over more alert lines since the last check; see ctl.sh logs $unit"; then keep=$last
    else left=$over; fi
  elif [ "$left" = 0 ]; then keep=$last
  fi
  [ -z "$keep" ] || save "$cur" "$keep"
  if [ "$left" -gt 0 ]; then held=$((held + left)); log "recourse-$unit: $left alert line(s) kept for the next run"; fi
}

check_health() { # check_health <health JSON>
  local rows s state restarts unit http result errs f prev prev_restarts title msg
  rows=$(jq -r '.services[] | [.service, (if .up then "up" else "down" end), (.restarts // "" | tostring), .unit,
    (if .http == 0 then "000" else (.http | tostring) end), (.result // "-"), ((.errors // []) | join(" | "))] | @tsv' <<<"$1") ||
    { log "the health JSON did not parse"; return 0; }
  while IFS=$'\t' read -r s state restarts unit http result errs; do
    [ -n "$s" ] || continue
    f="$STATE/health-$s"; prev=""; prev_restarts=""; title=""
    [ -f "$f" ] && read -r prev prev_restarts < "$f" || true
    if [ -z "$prev" ]; then : # first sight: record only
    elif [ "$prev" = up ] && [ "$state" = down ]; then
      title="recourse $s down"; msg=$(clean <<<"$s is down: unit $unit, http $http, last result $result${errs:+; $errs}")
    elif [ "$prev" = down ] && [ "$state" = up ]; then
      title="recourse $s back"; msg="$s is up again (unit $unit, http $http)"
    elif [ "$state" = up ] && [[ "$restarts" =~ ^[0-9]+$ ]] && [[ "$prev_restarts" =~ ^[0-9]+$ ]] && [ "$restarts" -gt "$prev_restarts" ]; then
      title="recourse $s restarted"; msg="$s restarted on its own $((restarts - prev_restarts)) time(s) since the last check and is up (last result $result)"
    fi
    if [ -n "$title" ] && ! notify "$title" "$msg"; then
      held=$((held + 1)); continue # the old state stays, so the next run sees the same change
    fi
    save "$f" "$state $restarts"
  done <<<"$rows"
}

first=0
[ -n "$(ls -A "$STATE" | grep -v '^\.lock$' || true)" ] || first=1
health=""
if [ -n "${WATCH_HEALTH_FILE:-}" ]; then health=$(cat "$WATCH_HEALTH_FILE")
else health=$(bash "$REPO/ops/units/ctl.sh" health --json 2>/dev/null) || { log "ctl.sh health --json failed"; health=""; }
fi
[ -z "$health" ] || check_health "$health"
for u in $UNITS; do forward_unit "$u"; done
if [ "$first" = 1 ]; then log "first run: recorded where the journals end and each service's state; nothing sent"
else
  [ "$sent" = 0 ] || log "$sent message(s) this run${NOTIFIER:+ through $NOTIFIER}"
  [ "$held" = 0 ] || log "$held message(s) kept for the next run: $STOPPED"
fi
