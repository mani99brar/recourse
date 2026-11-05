#!/usr/bin/env bash
# Start, stop and inspect the Recourse user units in the right order. Only the commands you give it run.
#   ctl.sh start [service...]     start in dependency order (default: all)
#   ctl.sh stop [service...]      stop in reverse order, keeper last
#   ctl.sh restart [service...]
#   ctl.sh status                 one line per unit: state and memory
#   ctl.sh health [service...]    GET /health on each service's local port
#   ctl.sh logs <service> [n]     last n journal lines (default 100)
# Services: keeper precheck shop status-api docket intake web
set -euo pipefail
ORDER=(keeper precheck shop status-api docket intake web)
declare -A PORT=([keeper]=8706 [precheck]=8705 [shop]=8720 [status-api]=8787 [docket]=8707 [intake]=8716 [web]=8788)
cmd=${1:-}; shift || true
svcs=("$@"); [ ${#svcs[@]} -gt 0 ] || svcs=("${ORDER[@]}")
ordered() { for s in "${ORDER[@]}"; do for w in "${svcs[@]}"; do [ "$s" = "$w" ] && echo "$s"; done; done; }
case "$cmd" in
  start)   for s in $(ordered); do systemctl --user start "recourse-$s"; echo "started $s"; done ;;
  stop)    for s in $(ordered | tac); do systemctl --user stop "recourse-$s"; echo "stopped $s"; done ;;
  restart) for s in $(ordered); do systemctl --user restart "recourse-$s"; echo "restarted $s"; done ;;
  status)
    for s in "${ORDER[@]}"; do
      u=recourse-$s
      printf '%-12s %-10s mem %s\n' "$s" "$(systemctl --user is-active "$u" 2>/dev/null || true)" \
        "$(systemctl --user show "$u" -p MemoryCurrent --value 2>/dev/null | awk '{ if ($1 ~ /^[0-9]+$/) printf "%d MB", $1/1048576; else print "-" }')"
    done ;;
  health)
    for s in $(ordered); do
      code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${PORT[$s]}/health" || true)
      printf '%-12s port %-5s /health %s\n' "$s" "${PORT[$s]}" "$code"
    done ;;
  logs) journalctl --user -u "recourse-${1:?service name}" -n "${2:-100}" --no-pager ;;
  *) sed -n '2,/^set -/p' "$0" | sed '$d'; exit 1 ;;
esac
