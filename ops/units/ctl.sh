#!/usr/bin/env bash
# Start, stop and inspect the Recourse user units in the right order. Only the commands you give it run.
#   ctl.sh start [service...]     start in dependency order (default: every service, not the tunnels)
#   ctl.sh stop [service...]      stop in reverse order, keeper last (default: every service, not the tunnels)
#   ctl.sh restart [service...]   (default: every service, not the tunnels)
#   ctl.sh status                 one line per unit: state and memory; the watch timer's state and last run;
#                                 then any process of this checkout that listens on a port from outside the units
#   ctl.sh health [--json] [service...]
#                                 per service: unit state, restarts, the HTTP code of its health endpoint, up or
#                                 down, and the error fields its health JSON reports (redacted); then any stray
#                                 listener. --json prints the same as one JSON object, for scripts.
#   ctl.sh logs <service> [n]     last n journal lines (default 100)
#   ctl.sh urls                   the current public https name of each tunnel
#   ctl.sh keeper <args>          keeper-ctl with the unit's port and state dir (status, pause, resume, ...)
# Services: keeper precheck shop status-api docket intake web tunnel-web tunnel-shop tunnel-named
# A tunnel runs only when named: restarting a quick tunnel (tunnel-web, tunnel-shop) gives it a new public name,
# which the shop's SHOP_PUBLIC_URL and the agent registrations then have to follow (README, Public tunnels).
# tunnel-named keeps fixed hostnames on a Cloudflare account once the operator has set it up (ops/tunnel).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
ORDER=(keeper precheck shop status-api docket intake web tunnel-web tunnel-shop tunnel-named)
SERVICES=(keeper precheck shop status-api docket intake web)
declare -A PORT=([keeper]=8706 [precheck]=8705 [shop]=8720 [status-api]=8787 [docket]=8707 [intake]=8716 [web]=8788
  [tunnel-web]=8789 [tunnel-shop]=8721 [tunnel-named]=8790)
# The tunnels report on cloudflared's metrics port, where /ready is 200 once the edge connection is up.
declare -A HPATH=([tunnel-web]=/ready [tunnel-shop]=/ready [tunnel-named]=/ready)
cmd=${1:-}; shift || true
json=0
svcs=()
for a in "$@"; do
  if [ "$cmd" = health ] && [ "$a" = --json ]; then json=1; else svcs+=("$a"); fi
done
if [ ${#svcs[@]} -eq 0 ]; then
  case "$cmd" in start|stop|restart) svcs=("${SERVICES[@]}") ;; *) svcs=("${ORDER[@]}") ;; esac
fi
ordered() { for s in "${ORDER[@]}"; do for w in "${svcs[@]}"; do [ "$s" = "$w" ] && echo "$s"; done; done; }
tunnel_note() { # after a quick tunnel (re)start: its public name is new
  for s in "${svcs[@]}"; do case "$s" in tunnel-web|tunnel-shop)
    echo "note: $s has a new public name. Run 'ctl.sh urls'; for tunnel-shop also set SHOP_PUBLIC_URL, restart shop"
    echo "      and refresh the agent registrations (ops/units/README.md, Public tunnels)."; break ;; esac; done
}
# Listening processes whose working directory is in this checkout but which no recourse unit owns,
# one "pid<TAB>address<TAB>all|loopback<TAB>cwd" line each.
stray_rows() {
  local line pid addr cwd cg scope
  while read -r line; do
    pid=$(grep -o 'pid=[0-9]*' <<<"$line" | head -1 | cut -d= -f2 || true); [ -n "$pid" ] || continue
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
    case "$cwd" in "$REPO"|"$REPO"/*) ;; *) continue ;; esac
    cg=$(cut -d: -f3- "/proc/$pid/cgroup" 2>/dev/null | head -1 || true)
    case "$cg" in */recourse-*.service) continue ;; esac
    addr=$(awk '{print $4}' <<<"$line")
    case "$addr" in 127.0.0.1:*|\[::1\]:*) scope=loopback ;; *) scope=all ;; esac
    printf '%s\t%s\t%s\t%s\n' "$pid" "$addr" "$scope" "${cwd#"$REPO"/}"
  done < <(ss -ltnpH 2>/dev/null || true)
}
strays() {
  local rows pid addr scope cwd
  rows=$(stray_rows)
  [ -n "$rows" ] || return 0
  while IFS=$'\t' read -r pid addr scope cwd; do
    [ "$scope" = all ] && addr="$addr (all interfaces)"
    printf 'stray        pid %s listens on %s, cwd %s, outside the units\n' "$pid" "$addr" "$cwd"
  done <<<"$rows"
  echo "  stop a stray yourself once you know what it is; ctl.sh does not touch processes it did not start"
}
# One service's health as a JSON object: unit state and restarts, the HTTP code, up (unit active and the
# endpoint answering 200), the service's own ok flag when it has one, and the error fields its health JSON
# reports, each "field: text" and redacted (ops/watch/redact.jq). Nothing else from the body is passed on.
health_one() {
  local s=$1 p=${HPATH[$1]:-/health} props out code body
  props=$(systemctl --user show "recourse-$s" -p LoadState -p ActiveState -p NRestarts -p Result 2>/dev/null || true)
  out=$(curl -s -m 5 -w '\n%{http_code}' "http://127.0.0.1:${PORT[$s]}$p" 2>/dev/null || true)
  code=${out##*$'\n'}; body=${out%$'\n'*}
  [ "$out" != "$code" ] || body=""
  [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
  printf '%s' "$body" | jq -c -R -s -L "$REPO/ops/watch" --arg svc "$s" --arg port "${PORT[$s]}" --arg path "$p" \
    --arg code "$code" --arg props "$props" '
    include "redact";
    (try fromjson catch null) as $b
    | ($props | split("\n") | map(select(length > 0) | capture("^(?<key>[^=]+)=(?<value>.*)$")) | from_entries) as $u
    | (if ($u.LoadState // "") == "not-found" then "not-installed" else ($u.ActiveState // "unknown") end) as $unit
    | (if ($b | type) != "object" then []
       elif $svc == "keeper" then [
         ($b.problems // [] | select(length > 0) | "problems: " + join("; ")),
         ($b.paramsError | select(. != null) | "paramsError: \(.)"),
         ($b.lastError | select(. != null) | "lastError: \(.)"),
         ($b.openIntents // [] | .[] | select(.lastError != null) | "openIntents \(.chain) \(.call): \(.lastError)")]
       elif $svc == "precheck" then [
         ($b.errors // [] | select(length > 0) | "errors: " + join("; ")),
         ($b.lastError | select(. != null) | "lastError: \(.)")]
       elif $svc == "shop" then [
         ($b.lastError | select(. != null) | "lastError: \(.)"),
         ($b.facilitator.consecutiveFailures? // 0 | select(. > 0) | "facilitator.consecutiveFailures: \(.)")]
       elif $svc == "status-api" then [
         ($b.degraded // [] | select(length > 0) | "degraded: " + join(", ")),
         ($b.rebuilding | select(. == true) | "rebuilding: true"),
         ($b.sources // {} | to_entries[] | select(.value.lastError? != null) | "sources.\(.key).lastError: \(.value.lastError)")]
       elif $svc == "docket" then [($b.failedWrites // 0 | select(. > 0) | "failedWrites: \(.)")]
       elif $svc == "intake" then [($b.llmStatus | select(. != null and . != "ok" and . != "disabled") | "llmStatus: \(.)")]
       elif ($svc | startswith("tunnel-")) then [($b.readyConnections | select(. == 0) | "readyConnections: 0")]
       else [] end) as $errors
    | {service: $svc, unit: $unit, restarts: (($u.NRestarts // "") | tonumber? // null), result: ($u.Result // null),
       port: ($port | tonumber), path: $path, http: ($code | tonumber),
       up: ($unit == "active" and $code == "200"),
       ok: (if ($b | type) == "object" and ($b.ok | type) == "boolean" then $b.ok else null end),
       errors: ($errors | map(tostring | redact | .[0:300]))}'
}
health() {
  local rows strays_json
  rows=$(for s in $(ordered); do health_one "$s"; done)
  strays_json=$(stray_rows | jq -c -R -s 'split("\n") | map(select(length > 0) | split("\t")
    | {pid: (.[0] | tonumber), address: .[1], allInterfaces: (.[2] == "all"), cwd: .[3]})')
  if [ "$json" = 1 ]; then
    jq -c -s --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson strays "$strays_json" \
      '{at: $at, services: ., strays: $strays}' <<<"$rows"
    return
  fi
  printf '%-12s %-13s %-8s %-4s %-5s %s\n' service unit restarts http state error
  jq -r '[.service, .unit, (.restarts // "-" | tostring), (if .http == 0 then "000" else (.http | tostring) end), (if .up then "up" else "down" end),
    (if (.errors | length) == 0 then "-" else (.errors | join(" | ") | .[0:240]) end)] | @tsv' <<<"$rows" |
    while IFS=$'\t' read -r s u r h st e; do printf '%-12s %-13s %-8s %-4s %-5s %s\n' "$s" "$u" "$r" "$h" "$st" "$e"; done
  strays
}
case "$cmd" in
  start)   for s in $(ordered); do systemctl --user start "recourse-$s"; echo "started $s"; done; tunnel_note ;;
  stop)    for s in $(ordered | tac); do systemctl --user stop "recourse-$s"; echo "stopped $s"; done ;;
  restart) for s in $(ordered); do systemctl --user restart "recourse-$s"; echo "restarted $s"; done; tunnel_note ;;
  status)
    for s in "${ORDER[@]}"; do
      u=recourse-$s
      printf '%-12s %-10s mem %s\n' "$s" "$(systemctl --user is-active "$u" 2>/dev/null || true)" \
        "$(systemctl --user show "$u" -p MemoryCurrent --value 2>/dev/null | awk '{ if ($1 ~ /^[0-9]+$/) printf "%d MB", $1/1048576; else print "-" }')"
    done
    printf '%-12s %-10s last run %s\n' watch "$(systemctl --user is-active recourse-watch.timer 2>/dev/null || true)" \
      "$(systemctl --user show recourse-watch.service -p ExecMainExitTimestamp --value 2>/dev/null | grep . || echo -)"
    strays ;;
  health) health ;;
  logs) journalctl --user -u "recourse-${1:?service name}" -n "${2:-100}" --no-pager ;;
  urls)
    for s in tunnel-web tunnel-shop; do
      u=$(journalctl --user -u "recourse-$s" --since "$(systemctl --user show "recourse-$s" -p ActiveEnterTimestamp --value)" \
        --no-pager -o cat 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)
      printf '%-12s %s\n' "$s" "${u:-none (not running, or no name yet)}"
    done
    # The named tunnel's hostnames are fixed: in its config (cert option) or in the Cloudflare dashboard.
    y="$HOME/.config/recourse/cloudflared.yml"
    h=$( { grep -oE '^[[:space:]]*-[[:space:]]*hostname:[[:space:]]*[^[:space:]]+' "$y" 2>/dev/null || true; } | awk '{print "https://" $NF}' | paste -sd' ' -)
    if [ -n "$h" ]; then printf '%-12s %s (%s)\n' tunnel-named "$h" "$(systemctl --user is-active recourse-tunnel-named 2>/dev/null || true)"
    elif [ -f "$y" ]; then printf '%-12s %s\n' tunnel-named "hostnames set in the Cloudflare dashboard (token option)"
    else printf '%-12s %s\n' tunnel-named "not set up (ops/tunnel/README.md)"; fi ;;
  # keeper-ctl reads these two from the environment; outside the unit nothing sets them.
  keeper)
    cd "$(dirname "$0")/../../services/keeper"
    KEEPER_STATE_DIR="$HOME/.local/state/recourse/keeper" KEEPER_PORT=${PORT[keeper]} exec node_modules/.bin/tsx src/ctl.ts "$@" ;;
  *) sed -n '2,/^set -/p' "$0" | sed '$d'; exit 1 ;;
esac
