#!/usr/bin/env bash
# Writes the Recourse systemd user units. It never starts or enables anything.
#
#   install.sh             dry run: prints what it would write and where
#   install.sh --verify    renders the units into a temp directory and runs systemd-analyze --user verify on them
#   install.sh --install   renders the units into ~/.config/systemd/user (or $SYSTEMD_USER_DIR) and runs
#                          systemctl --user daemon-reload. Nothing is started or enabled.
# Units: every recourse-*.service and recourse-*.timer in this folder.
#
# Env: NODE_BIN (default: the node on PATH, then the newest under ~/.nvm/versions/node), SYSTEMD_USER_DIR.
# The units read ~/.config/recourse/recourse.env and the optional ~/.config/recourse/<service>.env.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
MODE=dry
for a in "$@"; do
  case "$a" in
    --verify) MODE=verify ;; --install) MODE=install ;;
    -h|--help) sed -n '2,/^set -/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "install.sh: unknown argument $a" >&2; exit 1 ;;
  esac
done

NODE=${NODE_BIN:-$(command -v node || true)}
if [ -z "$NODE" ]; then NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true); fi
[ -x "$NODE" ] || { echo "install.sh: no node found; set NODE_BIN" >&2; exit 1; }
NODE=$(readlink -f "$NODE")

render() { # render <dir>
  mkdir -p "$1"
  for f in "$HERE"/recourse-*.service "$HERE"/recourse-*.timer; do
    sed -e "s|@NODE@|$NODE|g" -e "s|@REPO@|$REPO|g" "$f" > "$1/$(basename "$f")"
  done
}

case "$MODE" in
  dry)
    echo "# dry run. node: $NODE, repo: $REPO"
    for f in "$HERE"/recourse-*.service "$HERE"/recourse-*.timer; do
      echo "would write ${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}/$(basename "$f")"
    done
    echo "then: systemctl --user daemon-reload (nothing is started or enabled)" ;;
  verify)
    T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
    render "$T"
    systemd-analyze --user verify "$T"/recourse-*.service "$T"/recourse-*.timer && echo "units verify clean" ;;
  install)
    D=${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}
    render "$D"
    systemctl --user daemon-reload
    echo "installed to $D; nothing started. See ops/units/README.md to start." ;;
esac
