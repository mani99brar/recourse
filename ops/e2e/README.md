# ops/e2e: the whole test table in one command

`ops/e2e/run.sh` runs every check against whatever `deployments/*.json` says, and writes one table:
**path | result | tx hash or test name | note**. A result is `pass`, `fail`, `blocked` (could not be tested
this time: an upstream down, a panel the claim's state does not offer, a variable not set; the note says
which) or `dry-only` (built and simulated, nothing sent). After a redeploy the same command is run again
unchanged, and `compare.mjs` puts the two runs side by side.

```
bash ops/e2e/run.sh --label before-redeploy           # dry: preflight, ops, api, selftest, ui (25-40 min)
bash ops/e2e/run.sh --label after-redeploy            # the same, after deployments/*.json changed
node ops/e2e/compare.mjs before-redeploy after-redeploy   # side by side; lists rows that passed in one run only
bash ops/e2e/run.sh --only preflight,api              # some groups only (the preflight always runs)
bash ops/e2e/run.sh --send --label money-1            # also the money paths on testnet (below)
bash ops/e2e/run.sh --restarts --only restarts        # each service restarted alone (build session only)
bash ops/e2e/run.sh --suites --only suites            # pnpm test per package and forge test, pass counts
```

Output: `results/<label>/results.md` and `results.json` (header: commit, the deployments' addresses as the
repo's loaders read them, the run's times); `results/<label>/raw/` holds each part's JSON lines, logs and
screenshots and is not committed. Exit 1 when any row failed or a step stopped the run. A label that already
has a folder is refused (exit 2), so two attempts never mix in one table; `--replace` runs again under it and
moves the earlier attempt's raw files into `raw/prev-<time>/`, which the table does not read. `compare.mjs`
counts a row that passed in one run and is missing from the other as passed in only one run.

## What runs, in order

1. **preflight** (`state.mjs preflight`): `GET /v1/health` and `GET /v1/params` on the status API
   (`STATUS_API_URL`, default `http://127.0.0.1:8787`) must name the deployment files, vault token, contract
   addresses, chain ids and records topic that `services/status-api/src/deployments.ts` and
   `packages/records` read from this checkout. A difference stops the run (restart the status API on the new
   files first). `/v1/params` reads the contracts over the Hedera JSON-RPC relay; when it does not answer, the
   row is `blocked`, a dry run goes on, and `--send` stops.
2. **ops** (`ops-checks.sh check`): `ctl.sh health` (text and JSON), stray listeners, the watch's runs, every
   keeper and pre-check alert forwarded by the watch and found in the notifier's log, the watch's down/back
   messages, the keeper's gas floor and open intents. The notifier's log is `RECOURSE_NOTIFY_LOG` (read only);
   unset, those rows say `not checked: RECOURSE_NOTIFY_LOG unset`.
3. **api** (`api-agent.mjs`): through the web origin (`http://127.0.0.1:8788/api`), every v1 read and action
   with valid and invalid input, checked against the served `openapi.json` (status, schema, typed errors at
   their documented status); each built transaction decoded with `deployments/abi`, checked against
   `/v1/params` addresses, and simulated again on the public RPC. An RPC that does not answer makes the row
   `blocked`, a revert makes it `fail`. A read that would pass while the answer's `meta.degraded` names a chain
   source (`hedera`, `arbitrum`, `params`, `facts`, `vault`, `live`) is `blocked`, its note naming them and
   `meta.stale`'s ages: the API served last-good values. `hcs` and `identity` are only noted. Then the shop's
   catalog and x402 payment request, and the rate limit.
4. **selftest** (`api-agent.mjs --selftest`): the checks are run on broken copies of real answers and on wrong
   expectations; each row passes only when the broken one fails.
5. **ui** (`ui-wallet.mjs`): the web app in Chromium with an injected EIP-1193 wallet (the key, in send mode,
   stays in the Node process). Pages without a wallet at 1280 and 390 wide, the header connect, and each action
   panel (withdraw, evidence, contest, file, next step): the preview on screen against the API's answer and a
   second build; in a dry run the wallet simulates and declines. Needs `E2E_PLAYWRIGHT_DIR` (a
   `node_modules/playwright` folder with Chromium installed; Playwright is not a dependency of this repo) and
   1200 MB available; it runs under `E2E_LOCK` (else `SUITE_LOCK_FILE`).
6. **send**, **restarts**, **suites**: only with their flags (below).

Everything discovers claims, parties and addresses from the API, `deployments/*.json` and the party map
(`readParties`), so nothing names a contract address.

## What --send does (it has not run yet)

No `--send` path has been run: the steps below are wired from the existing CLIs and are untested end to end.
Each step records its transaction hashes, and a step that fails stops the run and says why.

1. `live-order --send --sku tee-navy-m --fault ordered-size=L` (`services/agent/scripts/live-order.ts`): an x402
   order whose ordered record states size L while the buyer asked for and saw M, a labelled demonstration of an
   agent-company mistake; the shop ships L, the buyer reports it, and live-order files claim A.
2. A second order B the same way with `--through report`, then the web app's fileClaim for it as the shop
   (`ui-wallet.mjs --send --as shop --flows file --order <B>`).
3. Claim A: the pre-check result (must be answer 1, against the agent company) and the contest window, both read
   from the API; nobody contests; the keeper's closeUncontested; then
   `withdraw-credit --as shop --send` and a read-back: credit 0 in the API, the shop's vault token balance up by
   the credit on the chain.
4. Claim B the same way, then the web app's withdraw as the shop (`--flows withdraw`) and the same read-back.
   Contest, evidence and the next-step panel are not sent: a contest takes the claim to court, which is the
   court case itself.
5. The payouts came out of the agent company's deposit. When the API's `balance` is below `required`
   (`inGoodStanding` is not the test: a vault with a top-up window keeps the party in good standing for that
   window), `ops/wire/07-deposit.sh <required> --send` (wiring step 4.1) tops it up to `required`; the read-back
   is `balance` at least `required`, `inGoodStanding` true and no `topUpDeadline`. In mock mode the platform's
   mUSDC is minted by the deployer first (`hedera.sh mint platform`); without it the step stops. The script
   appends a row to `deployments/wiring.json`.

Before the first send: `node ops/e2e/api-agent.mjs --check-signer --as shop` (and `--as platform`) loads each
key as a send does and prints only its address and balances.

`--restarts` (build session only) restarts web, intake, docket, status-api, precheck, shop and keeper one at a
time with `ops/units/ctl.sh restart <svc>`, each followed by `ops-checks.sh after <svc>`. Before each it checks
the plan's step 0 (`ops-checks.sh plan`): no claim within 10 minutes of its `deadline`, no contest window in the
keeper's `windowsActive`, no `live-order` running; before precheck its queue is 0, before keeper its
`openIntents` are empty. What it cannot read stops the run. An action in flight in the UI is not seen.

## Who signs what

| Step | Chain | Signer | Key variable |
|---|---|---|---|
| x402 order, payment, asked/shown/approval/ordered records | Hedera | the agent (live-order) | `AGENT_KEY_FILE` |
| arrived record and complaint | Hedera | the buyer (live-order) | `BUYER_KEY_FILE` |
| packed record, approve + fileClaim (CLI and web app) | Hedera | the shop | `SHOP_KEY_FILE` |
| pre-check finding | Hedera | the pre-check service | its own key |
| closeUncontested | Hedera | the keeper (ops-hedera) | the keeper's unit |
| withdrawCredit (CLI and web app) | Hedera | the shop | `SHOP_KEY_FILE` |
| deposit top-up (approve + postDeposit) | Hedera | the agent company (platform) | its Foundry keystore |
| restarts | none | the build session | none |

## What a --send run costs (estimated from past transactions on 6 Nov, not measured on the new contracts)

| Item | Paid by | About |
|---|---|---|
| order price, tee-navy-m, quantity 1 (catalog) | agent | 1.5 HBAR each, two orders: 3 HBAR |
| record messages on the topic (6 per order) | agent, shop, buyer | 0.004 HBAR each: 0.05 HBAR for both orders |
| mUSDC approve of the court fee | shop | 0.06 HBAR, twice |
| fileClaim (the API's budget is 800,000 gas) | shop | 0.7 HBAR, twice |
| court fee | shop | 1 mUSDC per claim, back as credit when it closes uncontested |
| closeUncontested | keeper (ops-hedera) | 0.19 HBAR per claim |
| withdrawCredit | shop | 0.05 HBAR, twice |
| deposit top-up | platform | the payouts in mUSDC (basket plus handling fee, about 3 mUSDC per claim from the params); HBAR fee not measured |
| Arbitrum Sepolia | nobody | 0 ETH: nothing in this round goes to court |

In all, about 3 HBAR from the agent (the two order prices; its share of the record messages is a few hundredths),
1.6 HBAR from the shop, 0.4 HBAR from the keeper, and some mUSDC moving
from the agent company's deposit to the shop. The shop needs at least 1 HBAR and 2 mUSDC before it starts.

## Parts

| File | What it does |
|---|---|
| `run.sh` | the one command: the groups above, the money paths, restarts, suites, then `results.mjs` |
| `state.mjs` | the checkout's deployments through the repo's loaders, the preflight, and the claim/party reads run.sh needs |
| `api-agent.mjs` | the agent over HTTP; also `--wait <claim> --status a,b`, `--check-signer`, `--send --as <role> --action <name>` |
| `ui-wallet.mjs` | the web app with an injected wallet; `--send --as <role> --flows <one flow>` signs only what the API built |
| `ops-checks.sh` | read-only service checks; `plan` prints the restart plan; `after <svc>` checks one restart |
| `results.mjs`, `compare.mjs` | one run's table; two runs side by side |
| `lib.mjs` | the repo's loaders (tsx), the OpenAPI checks, a paced HTTP client, read-only RPC, the table |
