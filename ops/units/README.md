# Service units

systemd user units for the Recourse services on this host. They are installed and running here; `ctl.sh status` shows each one. A change to a unit file takes effect only after `install.sh --install` and a restart of that unit.

| Unit | Service | Port | Health | MemoryMax |
|---|---|---|---|---|
| `recourse-keeper` | `services/keeper` | 8706 | `GET /health` | 192M |
| `recourse-precheck` | `services/precheck` | 8705 | `GET /health` | 192M |
| `recourse-shop` | `services/shop` | 8720 | `GET /health` | 192M |
| `recourse-status-api` | `services/status-api` | 8787 | `GET /health` | 160M |
| `recourse-docket` | `services/docket` | 8707 | `GET /health` | 160M |
| `recourse-intake` | `services/intake` | 8716 | `GET /health` | 160M |
| `recourse-web` | `ops/units/web-server.mjs` | 8788 | `GET /health` | 48M |
| `recourse-tunnel-web` | `cloudflared` quick tunnel to 8788 | 8789 (metrics) | `GET /ready` | 96M |
| `recourse-tunnel-shop` | `cloudflared` quick tunnel to 8720 | 8721 (metrics) | `GET /ready` | 96M |
| `recourse-tunnel-named` | `cloudflared` named tunnel: fixed hostnames for 8788 and 8720 (not set up yet, ops/tunnel) | 8790 (metrics) | `GET /ready` | 96M |
| `recourse-watch` (+ `.timer`) | `ops/watch/watch.sh`, every 2 minutes | none | its journal | 64M |

The limits add up to 1104M without the tunnels (1296M with them, 1360M with the watch's oneshot; the named tunnel's 96M takes the place of the quick tunnels' 192M once it runs), well under 2 GB on this 7.9 GB host, which has no swap and runs other workloads beside these; start only what a step needs and watch `ctl.sh status`. Startup compiles TypeScript through tsx, which peaks well above the steady state: on 6 Nov intake settled at 99 MB and was OOM-killed in a loop under a 96M cap, and the shop sat at 117 MB under 128M. Each cap sits above the highest peak seen on 6 Nov (`systemctl --user show recourse-<x> -p MemoryPeak`, and the `memory peak` the journal prints when a unit stops): keeper 148M, precheck 142M, shop 141M, docket 123M, status-api 108M, intake 102M, web 20M, tunnels 42M and 33M. The docket (123M under 128M) and the pre-check (142M under 160M) were raised to 160M and 192M. The keeper is the last unit to stop and the first to start.

**Host OOM kills.** A cap only stops one unit from growing; it does not protect a unit when the whole host runs short. On 6 Nov the kernel's OOM killer took the keeper and the docket twice each (the keeper at a 137.8M peak, well under its 192M cap) and the shop and the pre-check three times each, while other workloads filled the host; each came back 5 s later through `Restart=on-failure`. User units start at `oom_score_adj` 200 and interactive sessions at 0, so the kernel picks these services first. Every unit sets `OOMScoreAdjust=100`, the lowest a user unit can have: the user manager itself runs at 100, and a lower value (0, -100) is raised to 100 without a warning (tested with `systemd-run --user --wait --pipe -p OOMScoreAdjust=<n> cat /proc/self/oom_score_adj`). That halves the extra score these services carry (200 to 100 points; one point is about 8 MB of resident memory on this host), so other user units at 200 go first, but these services still go before an interactive session of the same size. Going lower needs root: system units, or a drop-in that lowers `OOMScoreAdjust=100` in `user@.service`. `node --test ops/units/units-env.test.mjs` checks the restart policy, the caps and their sum, and that systemd here gives 100.

Every service binds `127.0.0.1`, `intake` and `docket` included (`ss -ltn` lists each port above on loopback only). Only two things are reachable from outside, each through its Cloudflare quick tunnel: the web server (8788, which forwards `/api` to the status API on 8787) and the shop (8720). The host firewall (`ufw`) is not enabled, so a process started by hand that binds all interfaces is public: `ctl.sh status` ends with a `stray` line for any process of this checkout that listens on a port from outside the units; stop such a process once you have checked what it is.

How a unit runs:

- `WorkingDirectory` is the service folder and `ExecStart` is `node --import tsx src/main.ts` with the Node found by `install.sh`. There is no build step.
- `EnvironmentFile=%h/.config/recourse/recourse.env` (shared, holds keyed URLs and key file paths) then the optional `%h/.config/recourse/<service>.env`. The unit sets its own port and state directory as defaults; the env files win if they set the same names. The web server is the exception: it reads no shared file, only the optional `web.env` (see [What a unit can see](#what-a-unit-can-see)).
- `UnsetEnvironment=` then removes every key path, secret and keyed URL the service does not read. It is applied after all the env files, so a name it lists cannot be brought back from `<service>.env`; edit the unit instead.
- State: the keeper, pre-check, status API, docket and intake keep theirs in `~/.local/state/recourse/<service>` (the unit's `<SERVICE>_STATE_DIR`). The documents of the local content store (`IPFS_PIN_API_URL=file://`) are in `~/.local/state/recourse/ipfs`. The shop's and the agent's are different, see [Shop and agent state](#shop-and-agent-state).
- `Restart=on-failure`, `RestartSec=5`, `TimeoutStopSec=15`, `StartLimitIntervalSec=0` (no limit on restarts), `OOMScoreAdjust=100`. Output goes to the user journal.
- `NODE_OPTIONS=--max-old-space-size` is set a little below each `MemoryMax`.
- The static server serves `apps/web/dist` (build it first with the web package's build) and forwards `/api/*` to the status API with the prefix removed, so the web app's default `/api` base works with no extra proxy. Any path that is not a file serves `index.html`.
- There is no unit for the buying agent, and none is needed: it is a command-line tool that runs one order (or one approval, complaint or contest) and exits, so there is nothing long-running to restart or cap. `services/agent/src/main.ts` (`pnpm --filter @recourse/agent start`) serves its read-only approvals API on `127.0.0.1:$AGENT_PORT` (default 8722) when run by hand.

## Watch: alerts and down/up messages

The keeper and the pre-check POST their alerts to `ALERT_URL`, which is not set on this host, so their alerts (`outbound_slow`, `return_slow`, `relay_late`, `settle_late`, `settle_failed`, `exec_failure`, `sends_exhausted`, `mirror_lag`, ...) only reach their journals, as lines `alert <kind> [claim]: <hint>`. `recourse-watch.timer` runs `ops/watch/watch.sh` (`recourse-watch.service`, a oneshot) every two minutes. Each run:

1. forwards each new `alert ` line of `recourse-keeper` and `recourse-precheck` since its saved journal cursor, at most 20 per unit per run and one message counting the rest;
2. reads `ctl.sh health --json` and sends a message when a service goes from up to down, from down to up, or is up with a higher restart count than last time (an OOM kill and restart between two runs never shows as down). Each change is sent once.

The first run only records where each journal ends and each service's state, and sends nothing; a service first seen down (a unit not installed, say) is not reported until it has been up. The text sent is the alert line after `alert `, through `ops/watch/redact.jq` (a URL keeps only its scheme and host; 64-hex runs such as claim ids, JWTs and long tokens are replaced) and cut to 600 characters. The docket's alerts are JSON log lines and are not forwarded.

The notifier is the command in `RECOURSE_NOTIFY_CMD`, called as `<cmd> "<title>" "<message>"`. The unit file leaves it empty and reads the optional `~/.config/recourse/watch.env`, so put one line there, `RECOURSE_NOTIFY_CMD=<path of the operator's notify script>` (a path, no secret; the script reads its own channel settings, and the watch unit reads no other env file). With none, or one that is not executable, each message is only written to the unit's journal (`journalctl --user -u recourse-watch`) and the run still succeeds. State: `~/.local/state/recourse/watch/` (`journal-<unit>.cursor`, `health-<service>`); delete the folder to start over from a silent first run. Test: `node --test ops/watch/watch.test.mjs` (a fake journal folder, health file and notifier). Enable it once installed: `systemctl --user enable --now recourse-watch.timer`.

## Install (writes unit files only)

```
bash ops/units/install.sh            # dry run: lists what it would write
bash ops/units/install.sh --verify   # renders to a temp dir and runs systemd-analyze --user verify
node --test ops/units/units-env.test.mjs   # what each unit's environment can hold (also runs each one through systemd-run)
bash ops/units/install.sh --install  # writes ~/.config/systemd/user/recourse-*.service and .timer, and daemon-reloads
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
bash ops/units/ctl.sh health                # per service: unit, restarts, HTTP code, up/down, its error fields; then strays
bash ops/units/ctl.sh health --json         # the same as one JSON object (what the watch reads)
bash ops/units/ctl.sh logs keeper 200       # last 200 journal lines
bash ops/units/ctl.sh keeper status         # keeper-ctl: claims by phase, balances, pauses

systemctl --user start recourse-keeper
systemctl --user stop recourse-keeper
journalctl --user -u recourse-keeper -f
curl -s http://127.0.0.1:8706/health
systemctl --user show 'recourse-*' -p MemoryCurrent -p Id
journalctl --user --disk-usage
```

`ctl.sh health` reads each service's health endpoint on its local port (`/health`, or cloudflared's `/ready` on a tunnel's metrics port) and prints one row per service: the unit's state (`not-installed` when there is no unit file), its restart count since it was last started by hand (`NRestarts`: an OOM kill or a crash adds one), the HTTP code (`000`: nothing answered), `up` when the unit is active and the endpoint answers 200 (the keeper answers 503 when its last tick is stale or it cannot read the contract params) and `down` otherwise, and the error fields the service itself reports. Those are, by service: keeper `problems`, `paramsError`, `lastError` and each open intent's `lastError`; precheck `errors` (sources failing now; `ok` is false while there are any) and `lastError` (the latest one, kept after it clears); shop `lastError` and `facilitator.consecutiveFailures`; status-api `degraded` (sources behind or failing), `rebuilding` and `sources.<hedera|arbitrum|hcs>.lastError`; docket `failedWrites`; intake `llmStatus` when it is not `ok` or `disabled`; a tunnel `readyConnections` when it is 0. Error text goes through `ops/watch/redact.jq` first: a URL keeps only its scheme and host, and hex runs of 64 digits or more, JWTs and long mixed tokens are replaced, so a keyed RPC URL inside an error is never printed. `--json` prints `{at, services: [{service, unit, restarts, result, port, path, http, up, ok, errors}], strays: [...]}` and nothing else from the health bodies. The exit code is 0 either way; read `up`.

Enable at login (optional, after the first clean start): `systemctl --user enable recourse-keeper` and so on.

## Public tunnels

The web app (with its `/api` forward) and the shop are reached from outside through two Cloudflare quick tunnels. A quick tunnel needs no account: `cloudflared` (in `~/.local/bin`) asks the Cloudflare edge for a random `https://<words>.trycloudflare.com` name, which lasts as long as the process. A restart gives a new name, so after one:

1. `bash ops/units/ctl.sh urls` to read the new names;
2. set `SHOP_PUBLIC_URL` to the shop tunnel's name in `~/.config/recourse/recourse.env`, then restart `shop`. The web name needs no setting: the web app calls its own `/api`;
3. refresh the agent registrations with `pnpm --filter @recourse/agent h0-setup --update-uris` (dry run), then add `--broadcast`.

Only the web server and the shop are tunnelled. The keeper, precheck, intake and docket stay local. A stable name needs a named tunnel on a Cloudflare account, which this host does not have yet: `recourse-tunnel-named` and `ops/tunnel/setup.sh` are ready and wait for the operator's Cloudflare login or dashboard token (ops/tunnel/README.md). Once it runs, the quick tunnels can be stopped and these steps are needed only once more. `ctl.sh start`, `stop` and `restart` with no service list leave the tunnels alone; name `tunnel-web` or `tunnel-shop` to cycle one, and then do the three steps above.

## Updating

Stop the units in reverse order (keeper last), `git pull --ff-only`, `pnpm install --frozen-lockfile` if the lockfile changed, rebuild `apps/web` if it changed, `install.sh --install` if a unit file changed, start in order, then `ctl.sh health`. `ctl.sh stop` and `start` with no list do not touch the tunnels, so their public names survive an update. Never update with a fresh clone or `git clean -x`: the agent's journals, and the shop's until they are moved, sit in git-ignored folders of the checkout (next section). Do not stop the keeper near a claim deadline: check `bash ops/units/ctl.sh keeper status` first (keeper-ctl with the unit's port and state directory; plain `pnpm ctl status` in `services/keeper` fails because nothing outside the unit sets them).

## Shop and agent state

The shop's journals (`journal.jsonl` for paid orders, `claims.jsonl`, `records.jsonl`, `pay-once-journal.jsonl`) have been written to `services/shop/state/` in the checkout, and the agent's (`orders.jsonl`, `records.jsonl`, `pay-once.jsonl`) to `services/agent/state/`. Both folders are git-ignored, so `git pull` keeps them, but a fresh clone or `git clean -x` deletes them, and with them the shop's record of which orders were paid and which claims it filed. Back them up with the `~/.local/state/recourse` folders.

The shop unit now sets `SHOP_STATE_DIR=%h/.local/state/recourse/shop`. The shop code reads that variable from commit `2f11ccd` on (without it, it falls back to `services/shop/state`); a shop started before that commit still reads the old folder. Move the files as part of the restart onto that code, with the shop stopped:

```
bash ops/units/ctl.sh stop shop
git pull --ff-only            # the checkout must hold 2f11ccd or later
mkdir -p ~/.local/state/recourse/shop
mv services/shop/state/*.jsonl ~/.local/state/recourse/shop/
bash ops/units/install.sh --install && bash ops/units/ctl.sh start shop
```

Until the files are moved, the unit refuses to start the shop (an `ExecStartPre` check: `services/shop/state/journal.jsonl` has rows and the new folder has no `journal.jsonl`), so a restart cannot bring the shop up on an empty journal. Do not move them while the shop runs older code. The command-line scripts in `services/shop/scripts` (`pack`, `file-claim`, `reconcile`) do not see the unit's environment: after the move, run them with `SHOP_STATE_DIR=~/.local/state/recourse/shop` exported (or `--state`). Run without it, they look in `services/shop/state`, find no `journal.jsonl` and stop. The agent has no unit. It reads `AGENT_STATE_DIR` the same way and falls back to `services/agent/state`, where its journals still are; moving them is optional and needs the same export for every agent run.

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
| tunnel-named | none (no env file) | its tunnel token, read by cloudflared from `~/.config/recourse/cloudflared.token` (`--token-file`), never in the environment |
| watch | none (reads only the optional `watch.env`) | none |

`KEYSTORE_DIR` is removed everywhere: only the shell scripts use it. If the status API's port is ever changed in `recourse.env`, set the same `STATUS_API_PORT` in `web.env`. `node --test ops/units/units-env.test.mjs` checks this table against the unit files, against the names each service's source reads, and against what `systemd-run --user` actually passes on this host.

**What this does not stop.** Every unit still runs as the same user, and that user can read every keystore and its `.pass` file in `~/.config/recourse/keys`, the deployer's included. The deployer owns all three contracts, and none of them is locked, so code execution in the public shop or web process would be enough to take every deposit (`setPreCheckSigner`, `setBridgeMode` with its own relayer, or `setPeer`; see the README's owner powers). Removing the variables only removes the paths from the environment. Hiding the keystore folder needs a mount namespace, and this host cannot give a user unit one: Ubuntu's AppArmor setting `kernel.apparmor_restrict_unprivileged_userns=1` blocks the user namespace the user manager needs. Tested on 6 Nov with throwaway `systemd-run --user` units: `InaccessiblePaths=`, `ReadOnlyPaths=`, `ProtectHome=`, `ProtectSystem=` and `PrivateTmp=` are skipped without a word (the keystore folder stays readable), and `TemporaryFileSystem=` with `BindReadOnlyPaths=` stops the unit with status 226/NAMESPACE. So no unit uses them, and the test above fails if one does. Closing the gap needs the operator: lock the contracts (wire steps 6.4 and 6.5) or move their ownership off this host, and run the tunnelled shop and web server as their own system user (system units with `User=`, which need root), or allow user namespaces to the user manager in AppArmor and then add `InaccessiblePaths=%h/.config/recourse/keys` to web, status-api and intake, and `TemporaryFileSystem=%h/.config/recourse/keys` plus `BindReadOnlyPaths=` of the unit's own keystores and `.pass` files to the shop, docket, keeper and pre-check.

## Checks

`bash ops/watch/log-secret-scan.sh` reads every `recourse-*` journal and every file under `~/.local/state/recourse/*/` and `services/*/state/`, and looks for the values of the secret-looking variables in `~/.config/recourse/*.env` (compared inside one node process, never printed), 64-hex strings next to "key" or "private", and token, JWT, API-key and private-key shapes. It prints only the source, line numbers, the variable or pattern name and a count, and exits 1 on a hit (`node --test ops/watch/log-secret-scan.test.mjs` runs it on fixtures).

```
systemd-analyze --user verify ~/.config/systemd/user/recourse-*.service
systemctl --user kill -s KILL recourse-keeper; sleep 10; systemctl --user is-active recourse-keeper   # active again
```
