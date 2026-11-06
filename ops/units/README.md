# Service units

systemd user units for the Recourse services on this host. Nothing here is installed or started until you run the commands below.

| Unit | Service | Port | Health | MemoryMax |
|---|---|---|---|---|
| `recourse-keeper` | `services/keeper` | 8706 | `GET /health` | 192M |
| `recourse-precheck` | `services/precheck` | 8705 | `GET /health` | 160M |
| `recourse-shop` | `services/shop` | 8720 | `GET /health` | 192M |
| `recourse-status-api` | `services/status-api` | 8787 | `GET /health` | 160M |
| `recourse-docket` | `services/docket` | 8707 | `GET /health` | 128M |
| `recourse-intake` | `services/intake` | 8716 | `GET /health` | 160M |
| `recourse-web` | `ops/units/web-server.mjs` | 8788 | `GET /health` | 48M |
| `recourse-tunnel-web` | `cloudflared` quick tunnel to 8788 | 8789 (metrics) | `GET /ready` | 96M |
| `recourse-tunnel-shop` | `cloudflared` quick tunnel to 8720 | 8721 (metrics) | `GET /ready` | 96M |

The limits add up to 1040M without the tunnels (1232M with them); the host has about 1.5 GB free and no swap, so start only what a step needs and watch `ctl.sh status`. Startup compiles TypeScript through tsx, which peaks well above the steady state: on 6 Nov intake settled at 99 MB and was OOM-killed in a loop under a 96M cap, and the shop sat at 117 MB under 128M. The keeper is the last unit to stop and the first to start. Every service binds loopback except `intake` and `docket`, which listen on all interfaces because their code names no host; keep their ports closed at the firewall.

How a unit runs:

- `WorkingDirectory` is the service folder and `ExecStart` is `node --import tsx src/main.ts` with the Node found by `install.sh`. There is no build step.
- `EnvironmentFile=%h/.config/recourse/recourse.env` (shared, holds keyed URLs and key file paths) then the optional `%h/.config/recourse/<service>.env`. The unit sets its own port and state directory as defaults; the env files win if they set the same names.
- State lives in `~/.local/state/recourse/<service>`.
- `Restart=on-failure`, `RestartSec=5`, `TimeoutStopSec=15`, `StartLimitIntervalSec=0`. Output goes to the user journal.
- `NODE_OPTIONS=--max-old-space-size` is set a little below each `MemoryMax`.
- The static server serves `apps/web/dist` (build it first with the web package's build) and forwards `/api/*` to the status API with the prefix removed, so the web app's default `/api` base works with no extra proxy. Any path that is not a file serves `index.html`.
- There is no unit for the buying agent: it has no `src/main.ts` yet.

## Install (writes unit files only)

```
bash ops/units/install.sh            # dry run: lists what it would write
bash ops/units/install.sh --verify   # renders to a temp dir and runs systemd-analyze --user verify
bash ops/units/install.sh --install  # writes ~/.config/systemd/user/recourse-*.service and daemon-reloads
```

The host needs `loginctl enable-linger $USER` once so user units survive a logout (`loginctl show-user $USER -p Linger` should say `yes`).

## Start, stop, logs, health

`ctl.sh` keeps the order; the plain `systemctl` forms work too.

```
bash ops/units/ctl.sh start                 # all, in order: keeper precheck shop status-api docket intake web
bash ops/units/ctl.sh start keeper precheck # only these
bash ops/units/ctl.sh stop                  # reverse order, keeper last
bash ops/units/ctl.sh restart status-api
bash ops/units/ctl.sh status                # active state and memory per unit
bash ops/units/ctl.sh health                # GET /health on each local port
bash ops/units/ctl.sh logs keeper 200       # last 200 journal lines

systemctl --user start recourse-keeper
systemctl --user stop recourse-keeper
journalctl --user -u recourse-keeper -f
curl -s http://127.0.0.1:8706/health
systemctl --user show 'recourse-*' -p MemoryCurrent -p Id
journalctl --user --disk-usage
```

Enable at login (optional, after the first clean start): `systemctl --user enable recourse-keeper` and so on.

## Public tunnels

The web app (with its `/api` forward) and the shop are reached from outside through two Cloudflare quick tunnels. A quick tunnel needs no account: `cloudflared` (in `~/.local/bin`) asks the Cloudflare edge for a random `https://<words>.trycloudflare.com` name, which lasts as long as the process. A restart gives a new name, so after one:

1. `bash ops/units/ctl.sh urls` to read the new names;
2. set `SHOP_PUBLIC_URL` to the shop tunnel's name in `~/.config/recourse/recourse.env`, then restart `shop`. The web name needs no setting: the web app calls its own `/api`;
3. refresh the agent registrations with `pnpm --filter @recourse/agent h0-setup --update-uris` (dry run), then add `--broadcast`.

Only the web server and the shop are tunnelled. The keeper, precheck, intake and docket stay local. A stable name needs a named tunnel on a Cloudflare account, which this host does not have.

## Updating

Stop the units in reverse order (keeper last), `git pull --ff-only`, `pnpm install --frozen-lockfile` if the lockfile changed, rebuild `apps/web` if it changed, start in order, then `ctl.sh health`. Do not stop the keeper near a claim deadline: check `keeper-ctl status` (in `services/keeper`, `pnpm ctl status`) first.

## Checks

```
systemd-analyze --user verify ~/.config/systemd/user/recourse-*.service
systemctl --user kill -s KILL recourse-keeper; sleep 10; systemctl --user is-active recourse-keeper   # active again
```
