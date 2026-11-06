#!/usr/bin/env bash
# Recourse watch: tells the operator what the services otherwise only write to their logs. Run every two
# minutes by recourse-watch.timer (ops/units); safe to run by hand. One run:
#   1. forwards each new "alert ..." line the keeper and the pre-check wrote to the journal since the last run.
#      They POST alerts to ALERT_URL, which is not set on this host, so these lines are where alerts land.
#   2. reads `ctl.sh health --json` and sends a message when a service goes down or comes back, or restarted
#      on its own since the last run (an OOM kill and restart between two runs never shows as down).
# The first run (no saved state) only records where each journal ends and each service's state; it sends
# nothing, so enabling the timer does not replay old alerts.
# Sending: RECOURSE_NOTIFY_CMD names a command, called as <cmd> "<title>" "<message>". When it is unset, empty
# or not executable, each message is only logged (stdout, so the unit's journal) and the run still succeeds.
# What is sent: an alert line's text after "alert ", through ops/watch/redact.jq (a URL keeps only its scheme
# and host; 64-hex runs, JWTs and long tokens are replaced) and cut to 600 characters. At most WATCH_MAX_SENDS
# (default 20) alert messages per unit per run; the rest are counted in one more message.
# State: WATCH_STATE_DIR (default ~/.local/state/recourse/watch): journal-<unit>.cursor, health-<service>.
# Tests: WATCH_JOURNAL_DIR=<dir> reads <dir>/<unit>.log instead of the journal (the cursor is then a line
# count), WATCH_HEALTH_FILE=<file> reads the health JSON from a file instead of ctl.sh.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
STATE=${WATCH_STATE_DIR:-$HOME/.local/state/recourse/watch}
UNITS=${WATCH_ALERT_UNITS:-keeper precheck}
MAX=${WATCH_MAX_SENDS:-20}
mkdir -p "$STATE"
exec 9>"$STATE/.lock"
flock -n 9 || { echo "watch: the last run is still going; skipped"; exit 0; }

log() { printf 'watch: %s\n' "$*"; }
clean() { jq -R -r -L "$HERE" 'include "redact"; redact | .[0:600]'; }

NOTIFIER=""
if [ -n "${RECOURSE_NOTIFY_CMD:-}" ]; then NOTIFIER=$(command -v -- "$RECOURSE_NOTIFY_CMD" 2>/dev/null || true); fi
sent=0
notify() { # notify <title> <message>; the message is already clean
  sent=$((sent + 1))
  if [ -z "$NOTIFIER" ]; then
    log "no usable notifier (RECOURSE_NOTIFY_CMD ${RECOURSE_NOTIFY_CMD:+is not an executable command}${RECOURSE_NOTIFY_CMD:-is not set}); logged only: $1: $2"
  elif timeout 60 "$NOTIFIER" "$1" "$2" >/dev/null 2>&1; then
    log "sent: $1: $2"
  else
    log "the notifier failed; logged only: $1: $2"
  fi
}

# New output lines of recourse-<unit> since the saved cursor. With no cursor yet, it saves the journal's
# end and prints nothing.
journal_lines() {
  local unit=$1 cur n total f
  if [ -n "${WATCH_JOURNAL_DIR:-}" ]; then
    f="$WATCH_JOURNAL_DIR/$unit.log"; cur="$STATE/file-$unit.lines"
    [ -f "$f" ] || return 0
    total=$(wc -l < "$f")
    if [ ! -f "$cur" ]; then echo "$total" > "$cur"; return 0; fi
    n=$(cat "$cur"); [ "$n" -le "$total" ] || n=0
    tail -n "+$((n + 1))" "$f" | head -n "$((total - n))"
    echo "$total" > "$cur"
    return 0
  fi
  cur="$STATE/journal-$unit.cursor"
  if [ -f "$cur" ]; then journalctl --user -u "recourse-$unit" -o cat --no-pager -q --cursor-file="$cur"
  else journalctl --user -u "recourse-$unit" -o cat --no-pager -q -n 0 --cursor-file="$cur"; fi
}

forward_alerts() {
  local unit line text count
  for unit in $UNITS; do
    count=0
    while IFS= read -r line; do
      # The keeper stamps its lines with an ISO time; the pre-check does not.
      text=$(sed -nE 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z )?alert (.*)$/\2/p' <<<"$line")
      [ -n "$text" ] || continue
      count=$((count + 1))
      if [ "$count" -le "$MAX" ]; then notify "recourse $unit alert" "$(clean <<<"$text")"; fi
    done < <(journal_lines "$unit")
    if [ "$count" -gt "$MAX" ]; then
      notify "recourse $unit alert" "$((count - MAX)) more alert lines since the last check; see ctl.sh logs $unit"
    fi
  done
}

check_health() {
  local json rows s state restarts unit http result errs f prev prev_restarts
  if [ -n "${WATCH_HEALTH_FILE:-}" ]; then json=$(cat "$WATCH_HEALTH_FILE")
  else json=$(bash "$REPO/ops/units/ctl.sh" health --json 2>/dev/null) || { log "ctl.sh health --json failed"; return 0; }
  fi
  rows=$(jq -r '.services[] | [.service, (if .up then "up" else "down" end), (.restarts // "" | tostring), .unit,
    (if .http == 0 then "000" else (.http | tostring) end), (.result // "-"), ((.errors // []) | join(" | "))] | @tsv' <<<"$json") ||
    { log "the health JSON did not parse"; return 0; }
  while IFS=$'\t' read -r s state restarts unit http result errs; do
    [ -n "$s" ] || continue
    f="$STATE/health-$s"; prev=""; prev_restarts=""
    [ -f "$f" ] && read -r prev prev_restarts < "$f" || true
    printf '%s %s\n' "$state" "$restarts" > "$f"
    [ -n "$prev" ] || continue # first sight: record only
    if [ "$prev" = up ] && [ "$state" = down ]; then
      notify "recourse $s down" "$(clean <<<"$s is down: unit $unit, http $http, last result $result${errs:+; $errs}")"
    elif [ "$prev" = down ] && [ "$state" = up ]; then
      notify "recourse $s back" "$s is up again (unit $unit, http $http)"
    elif [ "$state" = up ] && [[ "$restarts" =~ ^[0-9]+$ ]] && [[ "$prev_restarts" =~ ^[0-9]+$ ]] && [ "$restarts" -gt "$prev_restarts" ]; then
      notify "recourse $s restarted" "$s restarted on its own $((restarts - prev_restarts)) time(s) since the last check and is up (last result $result)"
    fi
  done <<<"$rows"
}

first=0
[ -n "$(ls -A "$STATE" | grep -v '^\.lock$' || true)" ] || first=1
forward_alerts
check_health
if [ "$first" = 1 ]; then log "first run: recorded where the journals end and each service's state; nothing sent"
elif [ "$sent" -gt 0 ]; then log "$sent message(s) this run${NOTIFIER:+ through $NOTIFIER}"; fi
