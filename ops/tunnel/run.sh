#!/usr/bin/env bash
# Runs the named Cloudflare tunnel for recourse-tunnel-named.service, which calls it twice:
#   run.sh --check    ExecStartPre: says what is missing and exits 1 when the chosen way cannot run
#   run.sh            ExecStart: the same checks, then exec cloudflared (metrics and /ready on 127.0.0.1:8790)
# RECOURSE_TUNNEL_AUTH picks the way; the unit reads it from the optional ~/.config/recourse/tunnel.env:
#   token (default)   cloudflared tunnel --config cloudflared.yml run --token-file cloudflared.token
#   credentials       cloudflared tunnel --config cloudflared.yml run: the tunnel id and the credentials file
#                     that cloudflared.yml names. Option 1 only (`cloudflared tunnel create` wrote that file);
#                     the fallback for a token that does not pick up the config's ingress (ops/tunnel/README.md).
# The token is read only from its file, never from the environment or a command line, and is never printed.
# cloudflared would take a token from TUNNEL_TOKEN or TUNNEL_TOKEN_FILE, and a token wins over the credentials
# file, so those names and TUNNEL_CRED_CONTENTS are removed here as in the unit.
# Env: CLOUDFLARED (default ~/.local/bin/cloudflared), RECOURSE_CONFIG_DIR (default ~/.config/recourse).
set -euo pipefail
CF=${CLOUDFLARED:-$HOME/.local/bin/cloudflared}
CONF=${RECOURSE_CONFIG_DIR:-$HOME/.config/recourse}
YML=$CONF/cloudflared.yml
TOKEN=$CONF/cloudflared.token
AUTH=${RECOURSE_TUNNEL_AUTH:-token}
unset TUNNEL_TOKEN TUNNEL_TOKEN_FILE TUNNEL_CRED_CONTENTS
fail() { echo "recourse-tunnel-named: $*" >&2; exit 1; }
check=0
case "${1:-}" in --check) check=1 ;; "") ;; *) fail "unknown argument $1 (run.sh [--check])" ;; esac
[ -x "$CF" ] || fail "no cloudflared at $CF"
[ -s "$YML" ] || fail "$YML is missing or empty: run ops/tunnel/setup.sh first (ops/tunnel/README.md)"
yml_value() { # yml_value <top-level key>: its value in cloudflared.yml, without quotes or a trailing comment
  sed -n "s/^$1:[[:space:]]*//p" "$YML" | head -1 | sed -e 's/[[:space:]]#.*//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//"
}
case "$AUTH" in
  token)
    [ -s "$TOKEN" ] || fail "$TOKEN is missing or empty: run ops/tunnel/setup.sh first. A tunnel made by setup.sh's option 1 can run without it: put RECOURSE_TUNNEL_AUTH=credentials in $CONF/tunnel.env"
    args=(run --token-file "$TOKEN") ;;
  credentials)
    cred=$(yml_value credentials-file); cred=${cred/#\~\//$HOME/}
    [ -n "$cred" ] || fail "RECOURSE_TUNNEL_AUTH=credentials, but $YML names no credentials-file: a dashboard tunnel (option 2) runs only with its token; remove the line from $CONF/tunnel.env"
    [[ "$(yml_value tunnel)" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || fail "RECOURSE_TUNNEL_AUTH=credentials, but $YML names no tunnel id: run ops/tunnel/setup.sh --apply again"
    [ -s "$cred" ] || fail "RECOURSE_TUNNEL_AUTH=credentials, but the credentials file $cred that $YML names is missing or empty"
    args=(run) ;;
  # The value is not echoed: whatever was typed into tunnel.env stays out of the journal.
  *) fail "RECOURSE_TUNNEL_AUTH in $CONF/tunnel.env is neither token nor credentials" ;;
esac
if [ "$check" = 1 ]; then echo "recourse-tunnel-named: ready to run with the $AUTH"; exit 0; fi
exec "$CF" tunnel --no-autoupdate --metrics 127.0.0.1:8790 --config "$YML" "${args[@]}"
