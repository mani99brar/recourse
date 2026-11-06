# Runbook: the Recourse services on testnet

How to start, stop, check and recover each service on this host. The unit files, their limits and what each one can see are in [ops/units/README.md](../ops/units/README.md); the keeper's own procedures (a failed CCIP message, unreadable journal lines, alerts not delivered, an unreadable dispute) are in [services/keeper/RUNBOOK.md](../services/keeper/RUNBOOK.md); the fixed-hostname tunnel is in [ops/tunnel/README.md](../ops/tunnel/README.md). Every command runs from the checkout, `/home/agentops/dev/recourse`.

## The services

| Unit | Port | Does | State |
|---|---|---|---|
| `recourse-keeper` | 8706 | moves claims between Hedera and Arbitrum Sepolia: CCIP sends, opening cases, evidence, ruling relay, settle | `~/.local/state/recourse/keeper` (journal, control file) |
| `recourse-precheck` | 8705 | records the rule-based answer on each filed claim | `~/.local/state/recourse/precheck` |
| `recourse-shop` | 8720 | x402 seller and claim filer; public through a tunnel | `~/.local/state/recourse/shop` (`SHOP_STATE_DIR`; the journals have been moved there from `services/shop/state`) |
| `recourse-status-api` | 8787 | claims, chain state and documents for the web app | `~/.local/state/recourse/status-api` |
| `recourse-docket` | 8707 | fault rates | `~/.local/state/recourse/docket` |
| `recourse-intake` | 8716 | tags public feedback text | `~/.local/state/recourse/intake` |
| `recourse-web` | 8788 | serves `apps/web/dist`, forwards `/api/*` to 8787; public through a tunnel | none |
| `recourse-tunnel-web`, `-shop` | 8789, 8721 (metrics) | quick tunnels to 8788 and 8720; random names | none (the name is in the journal) |
| `recourse-tunnel-named` | 8790 (metrics) | fixed hostnames for both, once the operator has set it up | `~/.config/recourse/cloudflared.yml`, `.token`; optional `tunnel.env` (token or credentials) |
| `recourse-watch.timer` | none | every 2 minutes: alerts and down/up changes to the operator | `~/.local/state/recourse/watch` |

The buying agent has no unit: it is a command-line tool that runs one order and exits (`pnpm --filter @recourse/agent order`, ...); its journals are in `services/agent/state`. Documents of the local content store are in `~/.local/state/recourse/ipfs`. Every service binds `127.0.0.1`; only the web server and the shop are reachable from outside, through their tunnels.

## Start, stop, restart

The order is keeper, precheck, shop, status-api, docket, intake, web; stopping goes the other way, keeper last. `ctl.sh` keeps it and touches the tunnels only when they are named.

```
bash ops/units/ctl.sh start                    # every service, in order (not the tunnels)
bash ops/units/ctl.sh stop                     # reverse order, keeper last
bash ops/units/ctl.sh restart status-api       # one service
bash ops/units/ctl.sh start tunnel-web tunnel-shop   # new public names: see Tunnel names below
bash ops/units/ctl.sh start tunnel-named       # once set up (ops/tunnel/README.md)
systemctl --user enable --now recourse-watch.timer   # the watch; disable --now to stop it
```

- Before stopping the keeper, run `bash ops/units/ctl.sh keeper status` and do not stop it near a claim deadline.
- A changed unit file takes effect after `bash ops/units/install.sh --install` and a restart of that unit. `install.sh --verify` checks the files first.
- Updating the code: stop in reverse order, `git pull --ff-only`, `pnpm install --frozen-lockfile` if the lockfile changed, rebuild `apps/web` if it changed, start in order, `ctl.sh health` (ops/units/README.md, Updating). Never use a fresh clone or `git clean -x`: the shop's and the agent's journals sit in git-ignored folders.

## Check

```
bash ops/units/ctl.sh status          # state and memory per unit, the watch timer's last run, stray listeners
bash ops/units/ctl.sh health          # per service: unit, restarts, HTTP code, up or down, its error fields
bash ops/units/ctl.sh health --json   # the same for scripts
bash ops/units/ctl.sh keeper status [claimId]   # keeper /health (or one claim) and its control file
bash ops/units/ctl.sh logs keeper 200 # last 200 journal lines; journalctl --user -u recourse-<x> -f to follow
bash ops/watch/log-secret-scan.sh     # no key, token or keyed URL in any journal or state file
```

`ctl.sh health` columns: `unit` is systemd's state (`activating` while a restart is pending, `failed`, `not-installed`); `restarts` is how often systemd restarted it on its own (`NRestarts`); `http` is the health endpoint's code (`/health`, or cloudflared's `/ready` for a tunnel; `000` when nothing answers); `state` is `up` when the unit is active and the endpoint answers 200, else `down`; `error` lists the service's own error fields, URLs cut to their host. What the health bodies hold:

- **keeper**: `problems` (not empty means 503: no tick for four poll intervals and at least two minutes, contract params unreadable, or alerts waiting over 10 minutes when `ALERT_URL` is set), `lastError` (cleared by a clean tick) with `lastErrorAt` and `recentErrors`, `openIntents` (one per transaction signed and not yet resolved: `chain`, `call`, `claimId`, `ageS`, `rejections`, `reason`, `lastError`), `paused`, `windowsActive`, `claimsByPhase`, `levels` (fee pool, ops balances, LINK), `hederaLagS`, `alerts.delivery`.
- **precheck**: `ok` (false while a source is failing), `errors` (the failing sources), `lastError` (the latest, kept after it clears), `lag.mirrorS`, `queue` (claims still open), `claims` by state, `pause`.
- **shop**: `facilitator` (`rung`, `consecutiveFailures`), `lastError`.
- **status-api**: `sources.hedera|arbitrum|hcs` (`lagS`, `lastError`, `decodeFailures`), `degraded` (sources behind or failing, and `params`, `facts`, `vault` or `live` while that chain read is failing), `rebuilding`, `asOf`.
- **docket**: `failedWrites`, `lastEventAt`, `cursors`; its last poll failure is at `GET /sources` (`lastError`: the last failure of the latest poll pass, kept even when a later source in that pass answers, and null once a whole pass polls cleanly; the journal's `poll_failed` lines keep each one), which `ctl.sh health` shows as `sources.lastError`. **intake**: `llmStatus` (`disabled` with no LLM key or model, `paused` after a 402 or 429, `error`, `invalid_output`). **web**: `ok`. **tunnels**: `readyConnections`.

The running keeper may predate some of these fields (`problems` and the 503 came with a later commit); `ctl.sh health` copes with either.

## Recover

**OOM kill and restart.** The journal shows `recourse-<x>.service: Failed with result 'oom-kill'` and a restart 5 s later; `restarts` goes up and the watch sends "restarted". Every unit restarts on failure with no limit, so the usual job is to find why. The `memory peak` in the journal's `Consumed ...` line for that stop tells which kind: near the unit's `MemoryMax`, the cap is too low (raise it and the `--max-old-space-size` below it in the unit file, keeping `--max-semi-space-size=4` beside it in the quoted `NODE_OPTIONS`, then install and restart; intake looped under 96M on 6 Nov); well under it (the keeper died at 137.8M under 192M), the whole host ran short: check `free -m` and what else runs. With the current unit files installed, units run at `oom_score_adj` 100 (200 before) and interactive sessions at 0, so the kernel takes these first; a user unit cannot go lower.

**Mirror timeouts.** The Hedera testnet mirror node is public and sometimes slow. Signs: precheck `errors`/`lastError` like `mirror blocks: timeout on https://testnet.mirrornode.hedera.com/…` and `ok: false`, status-api `sources.hedera.lastError` or `sources.hcs.lastError` `This operation was aborted` and `degraded`, docket `poll_failed` `fetch failed` in its journal and `sources.lastError` in `ctl.sh health`. Each service retries on its next tick; the pre-check alerts `mirror_lag` after two minutes of failure. Nothing on this host needs changing; check that `lag.mirrorS` and `sources.*.lagS` fall back once it answers. Claims are not lost: cursors resume where they stopped.

**Hedera RPC down.** The public JSON-RPC relay can answer 502 or hang, and the whole network pauses during a Hedera testnet upgrade. The keeper and the pre-check move to `HEDERA_RPC_URL_2` when the first fails. Signs: the keeper's `problems` names unreadable contract params; status-api `degraded` lists `params`, `facts`, `vault` or `live`, each reply carries the last good read with its age in `stale` (`meta.stale` under `/v1`), and an action (a transaction the web app prepares) answers `upstream_unavailable` naming the RPC; the shop answers every new order `503 standing_unreadable`, because its standing check (`vault`, the default once `deployments/hedera.json` exists and `HEDERA_RPC_URL_1` is set) reads the vault through `HEDERA_RPC_URL_1` only, with no second relay. Each service reads again on its next tick or request. For a known window, add a keeper pause window (below) so the keeper sends nothing inside it; the pre-check takes its windows only from `SEND_PAUSE_WINDOWS`, at start, so a `ctl.sh` window does not pause it.

**A stuck intent.** The keeper and the pre-check sign at most one transaction per key at a time. In `ctl.sh keeper status`, an `openIntents` entry whose `ageS` keeps growing is stuck; `rejections` counts refusals in a row and `reason` says why (`funds`, `fee`, `nonce`, `other`). After a restart the keeper rebroadcasts an intent's stored bytes when the node does not know them and the nonce is unused; drops an intent after four refusals in a row once it is two minutes old and signs a fresh one (after a `funds` drop it waits 5 minutes before signing on that key, doubling with each such drop in a row up to 40 minutes). `reason: funds` (and a `gas_low` alert) means the ops account needs testnet gas: compare `levels.opsHederaWeibar` and `levels.opsArbWei`. To keep the keeper off one claim while looking: `ctl.sh keeper hold <claimId>`, then `ctl.sh keeper release <claimId>`.

**A CCIP message slow.** Alerts by phase: `outbound_slow` (claim sent from Hedera, not received on Arbitrum after 10 minutes), `relay_late` (ruled on Arbitrum, not relayed after 10 minutes), `return_slow` (relayed, the ruling not on Hedera after 45 minutes), `settle_late` (ruling on Hedera, not settled after 10 minutes), `settle_failed` (6 settle tries failed), `sends_exhausted` (every allowed send used). `ctl.sh keeper status <claimId>` lists the claim's `outbound` and `inbound` messages with their CCIP Explorer links. The keeper sends again by itself when a message is still Untouched 60 minutes after the last send and the contract allows it; a message in state Failure raises `exec_failure`: follow services/keeper/RUNBOOK.md. Past the claim timeout, `ctl.sh keeper expire <claimId>` lets the keeper expire the claim on Hedera even though a ruling has not arrived (that ruling is then ignored).

**Keeper pause windows.** For planned work on a chain or a known RPC outage: `bash ops/units/ctl.sh keeper window add hedera@2026-11-07T09:00:00Z/2026-11-07T10:00:00Z` (chain `hedera` or `arbitrum`, UTC times with `Z`). The keeper sends nothing on that chain inside the window and resumes after it; `/health` shows it in `windowsActive`. `window list` shows the control-file windows, `window clear` removes them (`SEND_PAUSE_WINDOWS` in `recourse.env` still applies; the pre-check reads only that variable, at start). `ctl.sh keeper pause` and `resume` stop and restart every send. Keep a window clear of claim deadlines.

**Tunnel name changes.** A restarted quick tunnel (by hand, or after a crash or OOM kill; the watch says "tunnel-shop restarted") has a new name. Then: `bash ops/units/ctl.sh urls`; set `SHOP_PUBLIC_URL` to the shop's new name in `~/.config/recourse/recourse.env` and `ctl.sh restart shop`; refresh the agent registrations with `pnpm --filter @recourse/agent h0-setup --update-uris` (dry run), then the operator adds `--broadcast`. The web name needs no setting. The named tunnel (ops/tunnel/README.md) ends this once it runs.

**A service that stays down.** `ctl.sh health <x>`, then `ctl.sh logs <x> 200`. `activating` with a growing `restarts` is a crash loop: the reason is in the last lines before each `Failed with result`. The shop refuses to start while its journals are still only in `services/shop/state` (ops/units/README.md, Shop and agent state), and when `PARTIES_FILE` is unset or names no file (`SHOP_ALLOW_NO_PARTIES=1` is for local runs only); with no records topic (neither `HCS_RECORDS_TOPIC_ID` nor the topic in `packages/records/h0-ids.json`) it starts but refuses complaints (503 `complaint_check_unavailable`). Once the party map holds more than one party of a role (the demo cast adds shops and agent companies), the shop, the agent's commands and the record writers stop with `parties: <n> parties are shop; set RECOURSE_SHOP_ADDRESS to this one's address` unless that role's selector is set in `recourse.env` (`RECOURSE_SHOP_ADDRESS`, `RECOURSE_PLATFORM_ADDRESS`, `RECOURSE_AGENT_ADDRESS`; [ops/cast/README.md](../ops/cast/README.md), step 1); today the map holds one party of each role. A web unit that is up but serves 404 for every page has no `apps/web/dist`: build the web package.

**The watch is silent.** `systemctl --user list-timers recourse-watch.timer` (is it enabled?), then `journalctl --user -u recourse-watch -n 50`: "no usable notifier" means `~/.config/recourse/watch.env` lacks a `RECOURSE_NOTIFY_CMD=<path>` line, or the path is not executable; "kept for the next run" means the notifier failed or timed out, and every message not sent waits for a run where it works (check the notifier's own channel). Deleting `~/.local/state/recourse/watch` starts it over with a silent first run and drops what waits. A short claim id in a message, `0x1a2b3c4d…9e8f`, is found in full with `ctl.sh logs keeper 500 | grep 0x1a2b3c4d`.

**A stray listener.** `ctl.sh status` and `health` end with a `stray` line for a process of this checkout that listens outside the units (for example a test server on all interfaces). Check what it is and stop it by hand; `ctl.sh` never stops a process it did not start.

## Where state and logs live

- Logs: the user journal, one unit each (`journalctl --user -u recourse-<x>`, `ctl.sh logs <x> [n]`, size with `journalctl --user --disk-usage`). The keeper stamps its lines with an ISO time; alerts are the lines `alert <kind> [claim]: <hint>`.
- State: `~/.local/state/recourse/<service>/` for keeper, precheck, status-api, docket, intake, shop and watch; `~/.local/state/recourse/ipfs/` for documents; `services/agent/state/` (and `services/shop/state/` before the move) in the checkout. Back these up together.
- Settings: `~/.config/recourse/recourse.env` (shared), the optional `<service>.env`, `watch.env`; key files under `~/.config/recourse/keys`, which no log or command here prints.
