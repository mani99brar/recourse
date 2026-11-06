# Setup

How to install, build and test Recourse, run it locally with nothing on a public network, and run it on the testnets. Every command runs from the checkout's root unless it says otherwise. Testnets only: nothing here talks to a mainnet.

## Prerequisites

| Tool | Version | Where the version comes from |
|---|---|---|
| Node.js | 22.12 or newer (the demo host runs 24.21) | `engines` in `package.json`; there is no `.nvmrc` |
| pnpm | 12.8.1 | `packageManager` in `package.json` (`corepack enable` provides it) |
| Foundry (`forge`, `cast`, `anvil`) | any release that can fetch solc 0.8.37 (the demo host runs forge 1.8.1) | `solc_version = "0.8.37"`, `evm_version = "cancun"` in `contracts/foundry.toml` |
| bash, `jq`, `python3`, `flock` | any recent | used by the scripts under `ops/` and `contracts/script` |
| systemd user session, `cloudflared` | any recent | only to run the services as units and reach them through tunnels (`ops/units`) |

The services run on Linux; their memory caps add up to about 1.1 GB ([ops/units/README.md](../ops/units/README.md)).

## Install

```
corepack enable                 # once, for the pinned pnpm
pnpm install --frozen-lockfile  # no dependency install scripts run (allowBuilds in pnpm-workspace.yaml)
```

The Solidity dependencies (OpenZeppelin, Chainlink CCIP, Chainlink Local, Kleros, forge-std) come from the same install: `contracts/remappings.txt` points into `node_modules`, and there are no git submodules.

## Build

The services and packages have no build step: each runs its TypeScript through `tsx`. Two things build:

```
pnpm --filter @recourse/web build   # the web app, into apps/web/dist (Vite)
cd contracts && forge build         # the contracts (or: pnpm forge:build)
```

## Test

This repository runs its tests one package at a time, so that a small host is not overloaded.

```
pnpm typecheck                              # every package that has a typecheck script, one at a time
pnpm test                                   # every package's vitest suite, one at a time
pnpm --filter @recourse/shared test         # one package: shared, records, court, renderer, agent, shop,
                                            # precheck, keeper, status-api, docket, intake, web
cd contracts && forge test --jobs 1         # Solidity unit, fuzz and invariant tests
```

Local runs against throwaway anvil nodes (no public network is touched):

```
pnpm --filter ./services/keeper test:anvil               # the keeper on two anvils with a local CCIP relay
pnpm --filter @recourse/shop test:anvil                  # the shop's claim filing on anvil
pnpm --filter @recourse/agent test:anvil                 # the agent's local demo as a test
bash contracts/script/hedera/hedera.sh rehearse <port>   # the Hedera deploy, step by step to the lock, on one anvil
bash ops/wire/rehearse.sh                                # both deploys and every wiring step on two anvils
bash ops/units/install.sh --verify                       # validates the service unit files
```

The anvil tests and local deploys take a file lock, `SUITE_LOCK_FILE`, so that two of them do not run at once. Its default is a path under the demo host's home folder; on another machine, set it to a file in a folder that exists. The local runs write only `*.local.json` files under `deployments/`, which git ignores.

## Run it locally

```
pnpm --filter @recourse/agent local-demo [--serve]
```

One whole order on this machine: the agent's three records before payment, an x402 payment, the ordered record, the shop's packed record, the buyer's arrived record and complaint, and the shop's claim on a local `RecourseClaims`. The contracts and a mock USDC run on a local anvil; the HCS topic is an in-memory stand-in; the facilitator is simulated, so no money moves and the settlement id starts with `fake-settlement:`; documents go to a local content store under the CIDs a public pin would get. With `--serve` it also serves the topic as a mirror node API so other local services can read it. Ports must be in 8570-8579 (`--anvil-port`, `--mirror-port`, `--shop-port`). The script's header (`services/agent/scripts/local-demo.ts`) lists what is real and what is simulated.

## Run it on the testnets

The demo host runs this today. In outline:

1. **Keys.** One Foundry keystore per role, outside the repo, in `KEYSTORE_DIR`; [keys.md](keys.md) lists the roles and their public addresses. Each `*_KEY_FILE` variable holds a keystore's path, never a key.
2. **Funding.** `ops/fund/01-complete-hedera.sh` to `05-write-ids.sh` complete each role's Hedera account, fund the Hedera roles and `ops-arb`, associate the USDC token, and write the account ids and `deployments/parties.json`; each is a dry run until `--send` (`--write` for the last). `ops/fund/balances.sh` reads the balances.
3. **Deploy.** `bash contracts/script/hedera/hedera.sh <step>` (the steps are listed at the top of that script; with the mock token, `mock-usdc` comes first) and `bash contracts/script/arbitrum/deploy.sh`. Each step is a dry run until it is given `--broadcast`.
4. **Wiring.** `ops/wire/00-readback.sh` to `12-set-fee-token.sh`, in the order of [ops/wire/order.md](../ops/wire/order.md): peers on both sides, LINK and the fee pool, CCIP gas, the platform deposit and its required amount, and last the one-way locks. Each step is a dry run until it is given `--send`, and each writes its transaction to `deployments/wiring.json`.
5. **Services.** `bash ops/units/install.sh --verify`, then `--install`, then `bash ops/units/ctl.sh start` and `bash ops/units/ctl.sh health`. The units, their limits and what each can see are in [ops/units/README.md](../ops/units/README.md); day-to-day operation is in [runbook.md](runbook.md).
6. **An order.** `pnpm --filter @recourse/agent order --sku tee-navy-m` shows what would happen and sends nothing; `--send` places the order. `pnpm --filter @recourse/agent live-order` runs one whole order through to a filed claim, also a dry run until `--send`.

## Settings

Values never live in git. The services read `~/.config/recourse/recourse.env` (shared by every unit and command) and then an optional `~/.config/recourse/<service>.env`; the watch reads `~/.config/recourse/watch.env`, and the web server only its own `web.env`. [.env.example](../.env.example) lists every name, and `packages/shared/src/env.ts` is the list the code checks against. By name only:

| Group | Names |
|---|---|
| Chains and data sources | `HEDERA_RPC_URL_1`, `HEDERA_RPC_URL_2`, `HEDERA_MIRROR_URL`, `ARB_RPC_URL`, `ARKIV_RPC_URL`, `ARKIV_ACCESS_KEY`, `X402_FACILITATOR_URLS`, `HCS_RECORDS_TOPIC_ID`, `ALERT_URL`, `SOURCIFY_VERIFIER_URL` |
| Documents (IPFS) | `IPFS_PIN_API_URL` (`file:///<dir>` for the content store on the host), `IPFS_PIN_API_KEY`, `IPFS_PIN_API_SECRET`, `IPFS_PIN_BUCKET` (all three for Filebase), `IPFS_GATEWAY_URL`, `IPFS_RATE_PER_MIN` |
| Intake's model | `LLM_API_KEY`, `LLM_MODEL` |
| Keystore paths | `KEYSTORE_DIR`, `DEPLOYER_KEY_FILE`, `OPS_HEDERA_KEY_FILE`, `OPS_ARB_KEY_FILE`, `PRECHECK_SIGNER_KEY_FILE`, `PLATFORM_KEY_FILE`, `AGENT_KEY_FILE`, `SHOP_KEY_FILE`, `SCHEME_KEY_FILE`, `BUYER_KEY_FILE`, `FACILITATOR_KEY_FILE` |
| Parties, deployments, tooling | `HEDERA_ACCOUNT_IDS`, `DEPLOYMENTS_DIR`, `PARTIES_FILE`, `SUITE_LOCK_FILE` |
| Contract deploy inputs | `RULING_RELAYER_ADDRESS`, `PRECHECK_SIGNER_ADDRESS`, `POOL_ADDRESS`, `ANVIL_PORT_HEDERA` |
| Agent and shop | `AGENT_SPEND_LIMIT_USDC`, `AGENT_MAX_ORDER_USDC`, `AGENT_DAILY_CAP_USDC`, `AGENT_APPROVAL_TTL_SEC`, `PRICE_ASSET`, `SHOP_PUBLIC_URL`, `SHOP_BASE_URL`, `SHOP_PORT`, `AGENT_PORT`, `SHOP_STANDING_CHECK`, `SHOP_STATE_DIR`, `AGENT_STATE_DIR`, `SHOP_CATALOG_FILE`, `STATUS_API_URL` |
| Pre-check and keeper | `PRECHECK_STATE_DIR`, `PRECHECK_PORT`, `PRECHECK_QUIET_S`, `KEEPER_STATE_DIR`, `KEEPER_PORT`, `KEEPER_REFILE_HOLD_MIN`, `KEEPER_ARB_CONFIRMATIONS`, `KEEPER_POLL_MS`, `SEND_PAUSE_WINDOWS` |
| Docket | `DOCKET_PORT`, `DOCKET_STATE_DIR`, `DOCKET_STORE` (`local` by default, or `arkiv`), `DOCKET_PUBLISH_THRESHOLD`, `DOCKET_SAMPLE_MODE`, `DOCKET_Z`, `DOCKET_POLL_SECONDS`, `DOCKET_RETRY_SECONDS`, `DOCKET_RETRY_MAX`, `ARKIV_LIFETIME_DAYS`, `ARKIV_PAGE_SIZE`, `ARKIV_MIN_TGLM`, `SCHEME_MIN_HBAR`, `REVIEWS_ENABLED` (off by default), `REVIEW_VALUE_FAULT`, `REVIEW_VALUE_CLEAR`, `REVIEW_TAG1` |
| Intake | `INTAKE_PORT`, `INTAKE_STATE_DIR`, `INTAKE_CORS_ORIGIN`, `INTAKE_MAX_BYTES`, `INTAKE_RATE_PER_MIN`, `INTAKE_LLM_TIMEOUT_MS`, `INTAKE_LLM_PAUSE_MIN` |
| Status API | `STATUS_API_PORT`, `STATUS_API_STATE_DIR`, `POLL_MS`, `ARB_CONFIRMATIONS`, `ARB_LOG_CHUNK`, `SOURCE_TIMEOUT_MS`, `VIEW_CACHE_MS`, `LAG_WARN_S_HEDERA`, `LAG_WARN_S_ARB`, `LAG_WARN_S_HCS`, `DOCKET_URL`, `INTAKE_URL`, `AGENT_URL`, `PRECHECK_URL`, `SHOP_URL`, `WEB_ORIGIN`, `COURT_URL_TEMPLATE` |
| Local runs only | `HEDERA_LOCAL_FILE`, `ARBITRUM_LOCAL_FILE`, `SHOP_ALLOW_NO_PARTIES` (`1` starts a shop with no party map, which takes any platform and checks no payer; without it the shop needs `PARTIES_FILE`) |
| Optional anvil tests | `LOCAL_ANVIL_URL`, `LOCAL_DEPLOYMENTS_FILE`, `TWO_CHAIN_HEDERA_URL`, `TWO_CHAIN_ARB_URL` (the status API's chain tests run only when these are set) |
| Web app, at build time | `VITE_STATUS_API_URL`, `VITE_ARKIV_PUBLIC_RPC_URL`, `VITE_POLL_MS` (public values only: they end up in the bundle) |
| Watch | `RECOURSE_NOTIFY_CMD` (in `watch.env`) |

## Deployment files

`deployments/` holds what each deployment wrote, and every service reads its contract addresses from there (`DEPLOYMENTS_DIR`), never from code: `hedera.json` (DepositVault, RecourseClaims, the vault token and its mode, parameters), `arbitrum.json` (RecourseCase and its parameters), `wiring.json` (each wiring step and its transaction), `parties.json` (each party's accounts and which records each may write), `retired.json` (earlier deployments) and `abi/` (the contracts' ABIs). Third-party addresses (CCIP routers, LINK, KlerosCore, the ERC-8004 registries) are in `packages/shared/src/addresses.ts`.
