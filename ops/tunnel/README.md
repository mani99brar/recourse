# Fixed hostnames: the named tunnel

Today the web app (with its `/api` forward) and the shop are public through two Cloudflare quick tunnels (`recourse-tunnel-web`, `recourse-tunnel-shop`). A quick tunnel needs no account, but its `https://<words>.trycloudflare.com` name changes whenever its unit restarts (an OOM kill included), and then the shop's `SHOP_PUBLIC_URL` and the agent registrations point at a dead name until someone fixes them (ops/units/README.md, Public tunnels).

A named tunnel on a Cloudflare account keeps two fixed hostnames, one for the web app and one for the shop, across restarts. Everything that does not need the operator is ready here:

| File | What it does |
|---|---|
| `ops/tunnel/setup.sh` | Dry run by default; `--apply` creates the tunnel and DNS routes (option 1) and writes the two files below. Never prints the token, and never replaces a token file that exists without `--force`. |
| `ops/units/recourse-tunnel-named.service` | `cloudflared tunnel --config ~/.config/recourse/cloudflared.yml run --token-file ~/.config/recourse/cloudflared.token`, metrics and `/ready` on `127.0.0.1:8790`. Restart on failure, 96M cap. |
| `~/.config/recourse/cloudflared.yml` | Written by setup.sh: the ingress (option 1) or no ingress (option 2). |
| `~/.config/recourse/cloudflared.token` | The tunnel token, mode 600. Read by cloudflared from the file, so it is never on a command line, in a unit's environment or in a log. |

`ctl.sh health tunnel-named` and `ctl.sh urls` know the unit; the watch reports it going down once it has been up.

## What the operator does (one of two)

Both need a domain whose DNS is on the operator's Cloudflare account, and two hostnames in it, for example `app.<domain>` and `shop.<domain>`.

**Option 1: log in on this host.**

```
~/.local/bin/cloudflared tunnel login     # prints a link; open it, pick the zone; writes ~/.cloudflared/cert.pem
bash ops/tunnel/setup.sh --web app.<domain> --shop shop.<domain>          # dry run: what it would do
bash ops/tunnel/setup.sh --web app.<domain> --shop shop.<domain> --apply  # creates tunnel "recourse", 2 CNAMEs, both files
```

`--name <name>` picks another tunnel name. A tunnel of that name that already exists is reused. setup.sh takes option 1 whenever `cert.pem` is there, so when `~/.config/recourse/cloudflared.token` already exists (a dashboard token saved for option 2, or an earlier run's) `--apply` stops before it creates or routes anything: move `cert.pem` aside to keep a dashboard token, or add `--force` to replace the token, which keeps the old one as `cloudflared.token.bak` (mode 600; a rerun that gets the same token leaves both files alone). `cert.pem` is the account credential `cloudflared` uses to create, route and delete tunnels; the unit needs only the token, so `cert.pem` can be moved off the host once the tunnel runs.

**Option 2: a dashboard tunnel.** In the Cloudflare dashboard (Zero Trust, Networks, Tunnels), create a tunnel of type cloudflared and add two public hostnames: `app.<domain>` to `http://127.0.0.1:8788` and `shop.<domain>` to `http://127.0.0.1:8720`. Copy the token from the command it shows (the long string that starts with `eyJ`), then:

```
install -m 600 /dev/null ~/.config/recourse/cloudflared.token   # then paste the token into it with an editor
bash ops/tunnel/setup.sh --web app.<domain> --shop shop.<domain> --apply   # nothing to create; writes the config
```

## The switch (the operator's session)

```
bash ops/units/install.sh --install
bash ops/units/ctl.sh start tunnel-named
bash ops/units/ctl.sh health tunnel-named        # up: /ready on 127.0.0.1:8790 answers 200
curl -s https://shop.<domain>/health; curl -s https://app.<domain>/api/health
```

The quick tunnels keep running beside it until they are stopped, so nothing breaks while the new names are checked. Option 1 runs the tunnel with its token and this config's ingress; that pairing has not been run on this host yet (no tunnel exists), so check both hostnames before stopping the quick tunnels. If they answer 404 or 503, the token is not picking up the local ingress: `cloudflared tunnel --config ~/.config/recourse/cloudflared.yml run` uses the credentials file the config names instead.

## After the switch

1. `SHOP_PUBLIC_URL=https://shop.<domain>` in `~/.config/recourse/recourse.env`, then `bash ops/units/ctl.sh restart shop`. The shop then serves `https://shop.<domain>/.well-known/agent-registration.json` with that base.
2. Point the agent registrations at it: `pnpm --filter @recourse/agent h0-setup --update-uris` (dry run; it reads `SHOP_PUBLIC_URL` and the key paths from `process.env`, so run it in a shell with `recourse.env` exported), then the same with `--broadcast` (a Hedera testnet transaction: the operator's call). After this one update the agentURI no longer changes when a tunnel restarts.
3. The web hostname needs no setting: the web app calls its own `/api`. Changing the public link people are given is the operator's decision.
4. Stop the quick tunnels: `bash ops/units/ctl.sh stop tunnel-web tunnel-shop` (and `systemctl --user disable` them if they were enabled). `ctl.sh urls` then shows the fixed hostnames.
5. To go back: `ctl.sh stop tunnel-named`, `ctl.sh start tunnel-web tunnel-shop`, and the three steps of ops/units/README.md, Public tunnels, for the new quick names.

## Why the config is not in ~/.cloudflared

`cloudflared` reads `~/.cloudflared/config.yml` when no `--config` is given, and the quick-tunnel units give none. With ingress rules in that file, a quick tunnel refuses to start ("You can't set the --url flag (or $TUNNEL_URL) when using multiple-origin ingress rules", in the cloudflared binary on this host), so the next restart of either quick tunnel would fail. The named tunnel's config lives in `~/.config/recourse/cloudflared.yml` instead and its unit names it with `--config`. Option 1 still writes the tunnel's credentials file to `~/.cloudflared/<id>.json`, where `cloudflared tunnel create` puts it; that file holds no ingress.
