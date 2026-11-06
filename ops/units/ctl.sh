#!/usr/bin/env bash
# Start, stop and inspect the Recourse user units in the right order. Only the commands you give it run.
#   ctl.sh start [service...]     start in dependency order (default: every service, not the tunnels)
#   ctl.sh stop [service...]      stop in reverse order, keeper last (default: every service, not the tunnels)
#   ctl.sh restart [service...]   (default: every service, not the tunnels)
#   ctl.sh status                 one line per unit: state and memory; then any process of this checkout that
#                                 listens on a port from outside the units
#   ctl.sh health [service...]    GET /health on each service's local port
#   ctl.sh logs <service> [n]     last n journal lines (default 100)
#   ctl.sh urls                   the current public https name of each tunnel
#   ctl.sh keeper <args>          keeper-ctl with the unit's port and state dir (status, pause, resume, ...)
# Services: keeper precheck shop status-api docket intake web tunnel-web tunnel-shop
# A tunnel runs only when named: restarting one gives it a new public name, which the shop's SHOP_PUBLIC_URL
# and the agent registrations then have to follow (README, Public tunnels).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
ORDER=(keeper precheck shop status-api docket intake web tunnel-web tunnel-shop)
SERVICES=(keeper precheck shop status-api docket intake web)
declare -A PORT=([keeper]=8706 [precheck]=8705 [shop]=8720 [status-api]=8787 [docket]=8707 [intake]=8716 [web]=8788
  [tunnel-web]=8789 [tunnel-shop]=8721)
# The tunnels report on cloudflared's metrics port, where /ready is 200 once the edge connection is up.
declare -A HPATH=([tunnel-web]=/ready [tunnel-shop]=/ready)
cmd=${1:-}; shift || true
svcs=("$@")
if [ ${#svcs[@]} -eq 0 ]; then
  case "$cmd" in start|stop|restart) svcs=("${SERVICES[@]}") ;; *) svcs=("${ORDER[@]}") ;; esac
fi
ordered() { for s in "${ORDER[@]}"; do for w in "${svcs[@]}"; do [ "$s" = "$w" ] && echo "$s"; done; done; }
tunnel_note() { # after a tunnel (re)start: its public name is new
  for s in "${svcs[@]}"; do case "$s" in tunnel-*)
    echo "note: $s has a new public name. Run 'ctl.sh urls'; for tunnel-shop also set SHOP_PUBLIC_URL, restart shop"
    echo "      and refresh the agent registrations (ops/units/README.md, Public tunnels)."; break ;; esac; done
}
# Listening processes whose working directory is in this checkout but which no recourse unit owns.
strays() {
  local found=0 line pid addr cwd cg
  while read -r line; do
    pid=$(grep -o 'pid=[0-9]*' <<<"$line" | head -1 | cut -d= -f2 || true); [ -n "$pid" ] || continue
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
    case "$cwd" in "$REPO"|"$REPO"/*) ;; *) continue ;; esac
    cg=$(cut -d: -f3- "/proc/$pid/cgroup" 2>/dev/null | head -1 || true)
    case "$cg" in */recourse-*.service) continue ;; esac
    addr=$(awk '{print $4}' <<<"$line")
    case "$addr" in 127.0.0.1:*|\[::1\]:*) ;; *) addr="$addr (all interfaces)" ;; esac
    printf 'stray        pid %s listens on %s, cwd %s, outside the units\n' "$pid" "$addr" "${cwd#"$REPO"/}"
    found=1
  done < <(ss -ltnpH 2>/dev/null || true)
  [ "$found" = 0 ] || echo "  stop a stray yourself once you know what it is; ctl.sh does not touch processes it did not start"
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
    strays ;;
  health)
    for s in $(ordered); do
      p=${HPATH[$s]:-/health}
      code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${PORT[$s]}$p" || true)
      printf '%-12s port %-5s %-7s %s\n' "$s" "${PORT[$s]}" "$p" "$code"
    done ;;
  logs) journalctl --user -u "recourse-${1:?service name}" -n "${2:-100}" --no-pager ;;
  urls)
    for s in tunnel-web tunnel-shop; do
      u=$(journalctl --user -u "recourse-$s" --since "$(systemctl --user show "recourse-$s" -p ActiveEnterTimestamp --value)" \
        --no-pager -o cat 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)
      printf '%-12s %s\n' "$s" "${u:-none (not running, or no name yet)}"
    done ;;
  # keeper-ctl reads these two from the environment; outside the unit nothing sets them.
  keeper)
    cd "$(dirname "$0")/../../services/keeper"
    KEEPER_STATE_DIR="$HOME/.local/state/recourse/keeper" KEEPER_PORT=${PORT[keeper]} exec node_modules/.bin/tsx src/ctl.ts "$@" ;;
  *) sed -n '2,/^set -/p' "$0" | sed '$d'; exit 1 ;;
esac
