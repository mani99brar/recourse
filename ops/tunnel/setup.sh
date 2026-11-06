#!/usr/bin/env bash
# Prepares the named Cloudflare tunnel that gives the web app and the shop fixed hostnames
# (recourse-tunnel-named.service). Dry run by default: it says which option it found and prints every
# command it would run and every file it would write. --apply does it. It never starts a unit and never
# prints the tunnel token.
#
#   ops/tunnel/setup.sh --web <hostname> --shop <hostname> [--name <tunnel name>] [--apply [--force]]
#
# Option 1, cert (after `cloudflared tunnel login` on this host wrote ~/.cloudflared/cert.pem):
#   creates the tunnel <name> (default recourse) unless it exists, routes DNS for both hostnames to it
#   (a CNAME in the Cloudflare zone of each hostname), writes ~/.config/recourse/cloudflared.yml with the
#   ingress (web -> http://127.0.0.1:8788, shop -> http://127.0.0.1:8720), and saves the tunnel's token to
#   ~/.config/recourse/cloudflared.token (mode 600) for the unit's --token-file.
#   A cloudflared.token that already exists (a dashboard tunnel's, or an earlier run's) is never replaced
#   without --force: --apply stops before it changes anything on Cloudflare or here. With --force the old
#   token is kept as cloudflared.token.bak (mode 600) when the new one differs.
# Option 2, token (a tunnel made in the Cloudflare dashboard, its token saved by the operator in
#   ~/.config/recourse/cloudflared.token, mode 600; the dashboard holds the two public hostnames):
#   nothing to create; it checks the token file's mode and writes a cloudflared.yml without ingress.
#   The hostnames are still given, for the next steps it prints.
# Env: CLOUDFLARED (default ~/.local/bin/cloudflared), RECOURSE_CONFIG_DIR (default ~/.config/recourse).
set -euo pipefail
CF=${CLOUDFLARED:-$HOME/.local/bin/cloudflared}
CONF=${RECOURSE_CONFIG_DIR:-$HOME/.config/recourse}
CERT=$HOME/.cloudflared/cert.pem
TOKEN=$CONF/cloudflared.token
YML=$CONF/cloudflared.yml
NAME=recourse WEB="" SHOP="" APPLY=0 FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --web) WEB=${2:?--web needs a hostname}; shift 2 ;;
    --shop) SHOP=${2:?--shop needs a hostname}; shift 2 ;;
    --name) NAME=${2:?--name needs a tunnel name}; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,/^set -/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "setup.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
HOST_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'
for h in "$WEB" "$SHOP"; do
  [[ "$h" =~ $HOST_RE ]] || { echo "setup.sh: give both hostnames, lower case, e.g. --web app.example.org --shop shop.example.org" >&2; exit 2; }
done
[ "$WEB" != "$SHOP" ] || { echo "setup.sh: the web and shop hostnames must differ" >&2; exit 2; }
[[ "$NAME" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "setup.sh: a tunnel name is letters, digits, - and _" >&2; exit 2; }
[ -x "$CF" ] || { echo "setup.sh: no cloudflared at $CF (set CLOUDFLARED)" >&2; exit 2; }

say() { if [ "$APPLY" = 1 ]; then echo "+ $*"; else echo "would run: $*"; fi; }
run() { say "$@"; [ "$APPLY" = 0 ] || "$@"; }
write_yml() { # write_yml <content>
  if [ "$APPLY" = 0 ]; then echo "would write $YML:"; sed 's/^/    /' <<<"$1"; return; fi
  mkdir -p "$CONF"; (umask 077; printf '%s\n' "$1" > "$YML.tmp"); mv "$YML.tmp" "$YML"; echo "wrote $YML"
}
next_steps() {
  cat <<EOF

Next, from the checkout (the operator's session):
  bash ops/units/install.sh --install
  bash ops/units/ctl.sh start tunnel-named
  bash ops/units/ctl.sh health tunnel-named      # up once /ready on 127.0.0.1:8790 answers 200
  curl -sI https://$WEB/ | head -1; curl -s https://$SHOP/health
Then switch (ops/tunnel/README.md, After the switch):
  SHOP_PUBLIC_URL=https://$SHOP in $CONF/recourse.env, then bash ops/units/ctl.sh restart shop
  pnpm --filter @recourse/agent h0-setup --update-uris              # dry run, then add --broadcast
  bash ops/units/ctl.sh stop tunnel-web tunnel-shop                  # once the fixed names work
EOF
}

if [ -f "$CERT" ]; then
  echo "option 1 (cert): $CERT found; tunnel $NAME, web $WEB, shop $SHOP"
  # A token already here may be a dashboard tunnel's (option 2) that a login left a cert beside: stop before
  # anything is created or routed, so a refusal leaves Cloudflare and this folder as they were.
  if [ -e "$TOKEN" ] && [ "$FORCE" = 0 ]; then
    if [ "$APPLY" = 1 ]; then
      cat >&2 <<EOF
setup.sh: $TOKEN already exists, and option 1 would replace it with tunnel $NAME's token. Nothing was changed.
  If it is a dashboard tunnel's token (option 2), move $CERT out of the way and run this again.
  To replace it, run this again with --force; the current token is then kept as $TOKEN.bak (mode 600).
EOF
      exit 1
    fi
    echo "note: $TOKEN already exists; --apply stops here unless --force is given (see --help)"
  fi
  # Read-only, also in a dry run: is there a tunnel of this name already?
  id=$("$CF" tunnel list --name "$NAME" --output json 2>/dev/null | jq -r '.[0].id // empty' 2>/dev/null || true)
  if [ -n "$id" ]; then echo "tunnel $NAME exists: $id"
  else
    run "$CF" tunnel create "$NAME"
    if [ "$APPLY" = 1 ]; then
      id=$("$CF" tunnel list --name "$NAME" --output json | jq -r '.[0].id // empty')
      [ -n "$id" ] || { echo "setup.sh: tunnel $NAME was not created" >&2; exit 1; }
    fi
  fi
  run "$CF" tunnel route dns "$NAME" "$WEB"
  run "$CF" tunnel route dns "$NAME" "$SHOP"
  write_yml "# Named tunnel $NAME for Recourse, written by ops/tunnel/setup.sh. Not in ~/.cloudflared: a config there
# with ingress rules would stop the quick tunnels (cloudflared refuses --url beside ingress rules).
tunnel: ${id:-<the id tunnel create prints>}
credentials-file: $HOME/.cloudflared/${id:-<id>}.json
ingress:
  - hostname: $WEB
    service: http://127.0.0.1:8788
  - hostname: $SHOP
    service: http://127.0.0.1:8720
  - service: http_status:404"
  say "$CF tunnel token $NAME > $TOKEN   (mode 600; the token is never printed)"
  if [ -e "$TOKEN" ] && [ "$APPLY" = 0 ] && [ "$FORCE" = 1 ]; then
    echo "would keep the current $TOKEN as $TOKEN.bak (mode 600) if the new token differs"
  fi
  if [ "$APPLY" = 1 ]; then
    (umask 077; "$CF" tunnel token "$NAME" > "$TOKEN.tmp")
    [ -s "$TOKEN.tmp" ] || { rm -f "$TOKEN.tmp"; echo "setup.sh: cloudflared tunnel token gave nothing" >&2; exit 1; }
    chmod 600 "$TOKEN.tmp"
    if [ -e "$TOKEN" ] && cmp -s "$TOKEN" "$TOKEN.tmp"; then
      rm -f "$TOKEN.tmp"; chmod 600 "$TOKEN"; echo "$TOKEN holds this token already; left as it is (mode 600)"
    else
      if [ -e "$TOKEN" ]; then
        (umask 077; cp "$TOKEN" "$TOKEN.bak.tmp"); chmod 600 "$TOKEN.bak.tmp"; mv "$TOKEN.bak.tmp" "$TOKEN.bak"
        echo "kept the old token as $TOKEN.bak (mode 600)"
      fi
      mv "$TOKEN.tmp" "$TOKEN"; echo "wrote $TOKEN (mode 600)"
    fi
  fi
  next_steps
elif [ -f "$TOKEN" ]; then
  echo "option 2 (token): $TOKEN found; nothing to create on Cloudflare"
  [ -s "$TOKEN" ] || { echo "setup.sh: $TOKEN is empty; paste the dashboard tunnel's token into it" >&2; exit 1; }
  mode=$(stat -c %a "$TOKEN")
  if [ "$mode" != 600 ]; then echo "setup.sh: $TOKEN is mode $mode; run chmod 600 $TOKEN first" >&2; exit 1; fi
  write_yml "# Named tunnel for Recourse, run with its dashboard token (written by ops/tunnel/setup.sh).
# The public hostnames live in the Cloudflare dashboard: $WEB -> http://127.0.0.1:8788,
# $SHOP -> http://127.0.0.1:8720. No ingress here.
no-autoupdate: true"
  next_steps
else
  cat >&2 <<EOF
setup.sh: neither $CERT nor $TOKEN exists. The operator picks one (ops/tunnel/README.md):
  1. cloudflared tunnel login on this host (a browser link; pick the zone of the two hostnames), then
     run this again with --apply;
  2. or make a tunnel in the Cloudflare dashboard (Zero Trust, Networks, Tunnels) with the public
     hostnames $WEB -> http://127.0.0.1:8788 and $SHOP -> http://127.0.0.1:8720, save its token in
     $TOKEN (chmod 600), then run this again with --apply.
EOF
  exit 2
fi
