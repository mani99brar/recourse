# Service units

systemd user units for the Recourse services on this host. They are installed and running here; `ctl.sh status` shows each one. A change to a unit file takes effect only after `install.sh --install` and a restart of that unit.

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

The limits add up to 1040M without the tunnels (1232M with them); the host has about 1.5 GB free and no swap, so start only what a step needs and watch `ctl.sh status`. Startup compiles TypeScript through tsx, which peaks well above the steady state: on 6 Nov intake settled at 99 MB and was OOM-killed in a loop under a 96M cap, and the shop sat at 117 MB under 128M. The keeper is the last unit to stop and the first to start.

Every service binds `127.0.0.1`, `intake` and `docket` included (`ss -ltn` lists each port above on loopback only). Only two things are reachable from outside, each through its Cloudflare quick tunnel: the web server (8788, which forwards `/api` to the status API on 8787) and the shop (8720). The host firewall (`ufw`) is not enabled, so a process started by hand that binds all interfaces is public: `ctl.sh status` ends with a `stray` line for any process of this checkout that listens on a port from outside the units; stop such a process once you have checked what it is.

How a unit runs:

- `WorkingDirectory` is the service folder and `ExecStart` is `node --import tsx src/main.ts` with the Node found by `install.sh`. There is no build step.
- `EnvironmentFile=%h/.config/recourse/recourse.env` (shared, holds keyed URLs and key file paths) then the optional `%h/.config/recourse/<service>.env`. The unit sets its own port and state directory as defaults; the env files win if they set the same names. The web server is the exception: it reads no shared file, only the optional `web.env` (see [What a unit can see](#what-a-unit-can-see)).
- `UnsetEnvironment=` then removes every key path, secret and keyed URL the service does not read. It is applied after all the env files, so a name it lists cannot be brought back from `<service>.env`; edit the unit instead.
- State: the keeper, pre-check, status API, docket and intake keep theirs in `~/.local/state/recourse/<service>` (the unit's `<SERVICE>_STATE_DIR`). The documents of the local content store (`IPFS_PIN_API_URL=file://`) are in `~/.local/state/recourse/ipfs`. The shop's and the agent's are different, see [Shop and agent state](#shop-and-agent-state).
- `Restart=on-failure`, `RestartSec=5`, `TimeoutStopSec=15`, `StartLimitIntervalSec=0`. Output goes to the user journal.
- `NODE_OPTIONS=--max-old-space-size` is set a little below each `MemoryMax`.
- The static server serves `apps/web/dist` (build it first with the web package's build) and forwards `/api/*` to the status API with the prefix removed, so the web app's default `/api` base works with no extra proxy. Any path that is not a file serves `index.html`.
- There is no unit for the buying agent. Orders are placed and approved from the command line; `services/agent/src/main.ts` (`pnpm --filter @recourse/agent start`) serves its read-only approvals API on `127.0.0.1:$AGENT_PORT` (default 8722) when run by hand.

## Install (writes unit files only)

```
bash ops/units/install.sh            # dry run: lists what it would write
bash ops/units/install.sh --verify   # renders to a temp dir and runs systemd-analyze --user verify
node --test ops/units/units-env.test.mjs   # what each unit's environment can hold (also runs each one through systemd-run)
bash ops/units/install.sh --install  # writes ~/.config/systemd/user/recourse-*.service and daemon-reloads
```

The host needs `loginctl enable-linger $USER` once so user units survive a logout (`loginctl show-user $USER -p Linger` should say `yes`).

## Start, stop, logs, health

`ctl.sh` keeps the order; the plain `systemctl` forms work too.

```
bash ops/units/ctl.sh start                 # every service, in order: keeper precheck shop status-api docket intake web
bash ops/units/ctl.sh start tunnel-web tunnel-shop   # the tunnels run only when named (a restart changes their names)
bash ops/units/ctl.sh start keeper precheck # only these
bash ops/units/ctl.sh stop                  # reverse order, keeper last; the tunnels keep running
bash ops/units/ctl.sh restart status-api
bash ops/units/ctl.sh status                # active state and memory per unit, then any stray listener of this checkout
bash ops/units/ctl.sh health                # GET /health on each local port
bash ops/units/ctl.sh logs keeper 200       # last 200 journal lines
bash ops/units/ctl.sh keeper status         # keeper-ctl: claims by phase, balances, pauses

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

Only the web server and the shop are tunnelled. The keeper, precheck, intake and docket stay local. A stable name needs a named tunnel on a Cloudflare account, which this host does not have. `ctl.sh start`, `stop` and `restart` with no service list leave the tunnels alone; name `tunnel-web` or `tunnel-shop` to cycle one, and then do the three steps above.

## Updating

Stop the units in reverse order (keeper last), `git pull --ff-only`, `pnpm install --frozen-lockfile` if the lockfile changed, rebuild `apps/web` if it changed, `install.sh --install` if a unit file changed, start in order, then `ctl.sh health`. `ctl.sh stop` and `start` with no list do not touch the tunnels, so their public names survive an update. Never update with a fresh clone or `git clean -x`: the agent's journals, and the shop's until they are moved, sit in git-ignored folders of the checkout (next section). Do not stop the keeper near a claim deadline: check `bash ops/units/ctl.sh keeper status` first (keeper-ctl with the unit's port and state directory; plain `pnpm ctl status` in `services/keeper` fails because nothing outside the unit sets them).

## Shop and agent state

The shop's journals (`journal.jsonl` for paid orders, `claims.jsonl`, `records.jsonl`, `pay-once-journal.jsonl`) have been written to `services/shop/state/` in the checkout, and the agent's (`orders.jsonl`, `records.jsonl`, `pay-once.jsonl`) to `services/agent/state/`. Both folders are git-ignored, so `git pull` keeps them, but a fresh clone or `git clean -x` deletes them, and with them the shop's record of which orders were paid and which claims it filed. Back them up with the `~/.local/state/recourse` folders.

The shop unit now sets `SHOP_STATE_DIR=%h/.local/state/recourse/shop`, which the shop reads once its code takes that variable. Move the files when that code is deployed, with the shop stopped:

```
bash ops/units/ctl.sh stop shop
mkdir -p ~/.local/state/recourse/shop
mv services/shop/state/*.jsonl ~/.local/state/recourse/shop/
bash ops/units/install.sh --install && bash ops/units/ctl.sh start shop
```

Until the files are moved, the unit refuses to start the shop (an `ExecStartPre` check: `services/shop/state/journal.jsonl` has rows and the new folder has no `journal.jsonl`), so a restart cannot bring the shop up on an empty journal. Do not move them before the shop code reads `SHOP_STATE_DIR`: older code still reads `services/shop/state`. The command-line scripts in `services/shop/scripts` and `services/agent/scripts` take their state folder from their own code, not from the unit. The agent has no unit, and its state stays in `services/agent/state`.

## What a unit can see

Each service gets only the key paths, secrets and keyed URLs its own code reads; `UnsetEnvironment=` in each unit removes the rest of `recourse.env`, and `SSH_AUTH_SOCK` from every unit:

| Unit | Key paths kept | Other secrets and keyed URLs kept |
|---|---|---|
| keeper | `OPS_HEDERA_KEY_FILE`, `OPS_ARB_KEY_FILE` | `ALERT_URL`, `HEDERA_RPC_URL_1`, `HEDERA_RPC_URL_2`, `ARB_RPC_URL` |
| precheck | `PRECHECK_SIGNER_KEY_FILE` | `ALERT_URL`, `HEDERA_RPC_URL_1`, `HEDERA_RPC_URL_2`, `IPFS_PIN_API_KEY`, `IPFS_PIN_API_SECRET` |
| shop | `SHOP_KEY_FILE`, `FACILITATOR_KEY_FILE` (the self-hosted facilitator rung) | `HEDERA_RPC_URL_1` |
| status-api | none | `HEDERA_RPC_URL_1`, `HEDERA_RPC_URL_2`, `ARB_RPC_URL` |
| docket | `SCHEME_KEY_FILE` (used with `DOCKET_STORE=arkiv` or `REVIEWS_ENABLED`) | `ARKIV_ACCESS_KEY`, `ARKIV_RPC_URL`, `ALERT_URL`, `HEDERA_RPC_URL_1`, `ARB_RPC_URL`, `IPFS_PIN_API_KEY`, `IPFS_PIN_API_SECRET` |
| intake | none | `LLM_API_KEY`, `IPFS_PIN_API_KEY`, `IPFS_PIN_API_SECRET` |
| web | none: it reads no shared env file, only the optional `web.env`, and the unit sets `STATUS_API_PORT=8787` itself | none |
| tunnel-web, tunnel-shop | none (no env file) | none |

`KEYSTORE_DIR` is removed everywhere: only the shell scripts use it. If the status API's port is ever changed in `recourse.env`, set the same `STATUS_API_PORT` in `web.env`. `node --test ops/units/units-env.test.mjs` checks this table against the unit files, against the names each service's source reads, and against what `systemd-run --user` actually passes on this host.

**What this does not stop.** Every unit still runs as the same user, and that user can read every keystore and its `.pass` file in `~/.config/recourse/keys`, the deployer's included. The deployer owns all three contracts, and none of them is locked, so code execution in the public shop or web process would be enough to take every deposit (`setPreCheckSigner`, `setBridgeMode` with its own relayer, or `setPeer`; see the README's owner powers). Removing the variables only removes the paths from the environment. Hiding the keystore folder needs a mount namespace, and this host cannot give a user unit one: Ubuntu's AppArmor setting `kernel.apparmor_restrict_unprivileged_userns=1` blocks the user namespace the user manager needs. Tested on 6 Nov with throwaway `systemd-run --user` units: `InaccessiblePaths=`, `ReadOnlyPaths=`, `ProtectHome=`, `ProtectSystem=` and `PrivateTmp=` are skipped without a word (the keystore folder stays readable), and `TemporaryFileSystem=` with `BindReadOnlyPaths=` stops the unit with status 226/NAMESPACE. So no unit uses them, and the test above fails if one does. Closing the gap needs the operator: lock the contracts (wire steps 6.4 and 6.5) or move their ownership off this host, and run the tunnelled shop and web server as their own system user (system units with `User=`, which need root), or allow user namespaces to the user manager in AppArmor and then add `InaccessiblePaths=%h/.config/recourse/keys` to web, status-api and intake, and `TemporaryFileSystem=%h/.config/recourse/keys` plus `BindReadOnlyPaths=` of the unit's own keystores and `.pass` files to the shop, docket, keeper and pre-check.

## Checks

```
systemd-analyze --user verify ~/.config/systemd/user/recourse-*.service
systemctl --user kill -s KILL recourse-keeper; sleep 10; systemctl --user is-active recourse-keeper   # active again
```
