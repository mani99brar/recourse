# Recourse

Recourse lets a shop recover money when an AI shopping agent buys the wrong thing.

An agent pays a shop over x402 (an HTTP payment protocol: the shop answers `402 Payment Required` with a price, and the client pays and asks again) on Hedera. Before it pays, it commits three records to a Hedera Consensus Service (HCS) topic: what it was asked, what it showed the buyer, and the approval. After the payment settles it commits a fourth, the ordered record, which carries the payment's transaction id; the shop commits what it packed. If the wrong goods arrive, the shop files a claim on Hedera and escrows a court fee. A rule-based pre-check compares the records, names the gap and the side at fault, and the losing side may contest. A contest crosses Chainlink CCIP (Cross-Chain Interoperability Protocol) to Arbitrum Sepolia, where a Kleros court rules. The ruling crosses back, and a deposit posted by the agent company pays the shop. On the testnet demo the deposit, the court fee and any payout are in mUSDC, a mock USDC token deployed for the demo, because Circle's testnet USDC faucet did not deliver. A docket service counts ruled cases per agent company and shop, for fault rates, and publishes them on the Arkiv testnet.

Built at ETHGlobal Mumbai, 5-7 Nov 2026. Testnets only. All shop and agent-company names are fictional.

**Demo:** https://mississippi-job-dot-respected.trycloudflare.com (testnets only; served from the team's host through a Cloudflare quick tunnel, so the address changes if the tunnel restarts). Start with **How it works** (`#/story`). Questions a judge is likely to ask: [docs/judges-faq.md](docs/judges-faq.md).

> **Status, 6 Nov 2026: running on testnets, configuration not locked.** The contracts are deployed on Hedera testnet and Arbitrum Sepolia and the services run on one host. Six claims have run to the end. Three found the agent company at fault and paid the shop from the agent company's deposit: the payout case (claim `0x8f78…6f75`, an order with a staged wrong size, closed uncontested at 19:35 UTC on 6 Nov, 2.575 mUSDC paid from Parcel Minds' deposit, and the shop's 3.575 mUSDC credit withdrawn at 19:37 UTC; [its rows](#deployed-addresses-and-transactions)) and a demo-cast claim (3.1 mUSDC from Wren Errands' deposit to Kestrel Outfitters, closed at 21:36 UTC and withdrawn at 21:55 UTC). Two closed uncontested with nobody at fault, and one was contested, ruled 3 ("neither side at fault") by Kleros court 8 (dispute 212), sent back to Hedera over CCIP and settled there at 11:10 UTC. The third went the whole way through the court: in claim `0x00ad…feae` the pre-check found the agent company at fault, the agent company contested, the claim crossed to Arbitrum over CCIP, Kleros court 8 ruled 1 (the agent company at fault) in dispute 213, the ruling came back over CCIP, and at 23:23 UTC the claim settled on Hedera: 3.575 mUSDC from Parcel Minds' deposit to the shop (the basket, handling and the shop's court fee), which the shop withdrew at 23:25 UTC. A demo cast of three more shops and three more agent companies is registered on ERC-8004, and its agents placed five orders on the evening of 6 Nov; since 21:40 UTC the docket writes its ruled cases and monthly counts to the Arkiv testnet. None of the three contracts is locked yet, so the deployer key can still change every setting, including ones that decide claims ([owner powers](#owner-powers-and-spend-paths)). See [What is live and what is not](#what-is-live-and-what-is-not).

## Contents

1. [Architecture](#architecture)
2. [One claim, end to end](#one-claim-end-to-end)
3. [How each technology is used](#how-each-technology-is-used)
4. [Repository layout](#repository-layout)
5. [Setup and tests](#setup-and-tests) (full guide: [docs/setup.md](docs/setup.md))
6. [Open-source libraries](#open-source-libraries)
7. [Owner powers and spend paths](#owner-powers-and-spend-paths)
8. [What is live and what is not](#what-is-live-and-what-is-not)
9. [Deployed addresses and transactions](#deployed-addresses-and-transactions)
10. [Known limits](#known-limits)
11. [Disclosures](#disclosures)

Questions a judge is likely to ask, answered with their evidence: [docs/judges-faq.md](docs/judges-faq.md).

## Architecture

```mermaid
flowchart LR
  subgraph H["Hedera testnet (296)"]
    HCS[("HCS records topic")]
    USDC[("Vault token: mUSDC, testnet mock<br/>(Circle USDC 0.0.429274 in circle mode)")]
    CL["RecourseClaims"]
    V["DepositVault"]
    CL --- V
  end
  subgraph A["Arbitrum Sepolia (421614)"]
    RC["RecourseCase"]
    KC["Kleros court 8"]
    RC --> KC
  end
  AG["Buying agent<br/>(services/agent)"] -- "x402 payment (HBAR with PRICE_ASSET=hbar)" --> SH["Shop<br/>(services/shop)"]
  AG -- "records I S A O R" --> HCS
  SH -- "record D" --> HCS
  V -- "deposit, court fee, payouts" --- USDC
  SH -- "fileClaim + court fee" --> CL
  PC["Pre-check<br/>(services/precheck)"] -- "reads records, recordPreCheck" --> CL
  CL <-- "CCIP: ClaimToCourt / RulingBack" --> RC
  KP["Keeper<br/>(services/keeper)"] -- "openCase, evidence, refile, resend" --> RC
  KP -- "settle, resend" --> CL
  V -- "applyOutcome: pays the shop's credit" --> SH
  ST["Status API + web app"] -. reads .-> CL
  ST -. reads .-> RC
  DK["Docket<br/>(services/docket)"] -- "ruled cases and monthly counts (DOCKET_STORE=arkiv)" --> AR[("Arkiv testnet")]
  DK -- "reviews, with REVIEWS_ENABLED (off today)" --> ER["ERC-8004 registries"]
  IN["Intake<br/>(services/intake)"] -- "tags public feedback" --> DK
```

The two chains never share state. Everything either side needs from the other travels as a CCIP message of fixed layout ([interfaces](docs/spec/interfaces.md), section 8), and every receive path decodes defensively: a bad message is ignored with an event and never reverts, so one bad message cannot block a lane.

## One claim, end to end

```mermaid
sequenceDiagram
  participant Ag as Agent
  participant Sh as Shop
  participant HCS as HCS topic
  participant CL as RecourseClaims (Hedera)
  participant PC as Pre-check
  participant KP as Keeper
  participant RC as RecourseCase (Arbitrum)
  participant K as Kleros court 8
  Ag->>HCS: records I S A (asked, shown, approval)
  Ag->>Sh: x402 payment, HBAR with PRICE_ASSET=hbar, else USDC
  Ag->>HCS: record O (ordered, with the payment's settlement tx id)
  Sh->>HCS: record D (packed)
  Note over Ag,Sh: the wrong goods arrive
  Ag->>HCS: record R (arrived), signed by the buyer
  Sh->>CL: fileClaim + court fee (1 USDC on the testnet demo, in mUSDC while it runs on the mock) into the vault escrow
  PC->>HCS: read the six records, run the fault rule
  PC->>CL: recordPreCheck (gap, answer, hash of the result document)
  alt nobody contests in the window
    CL->>CL: closeUncontested: fee refunded, shop paid if the finding was against the platform
  else the losing side contests
    CL->>RC: CCIP ClaimToCourt
    KP->>RC: openCase (dispute on Kleros, fee from the case's pool), then the evidence
    K->>RC: rule(disputeId, ruling)
    RC->>CL: CCIP RulingBack (relayRuling, anyone may call)
    CL->>CL: ruling recorded
  end
  KP->>CL: settle (anyone may call)
  CL->>CL: vault pays the shop's credit from the platform deposit
  Sh->>CL: withdrawCredit on the DepositVault (the vault token out to the shop)
```

1. **Records.** Six records per order, one HCS message each ([interfaces](docs/spec/interfaces.md), section 2): asked (I), shown (S), approval (A), ordered (O), packed (D), arrived (R). The agent writes asked, shown and approval before it pays and ordered after the payment settles (`services/agent/src/buy.ts`); the shop writes packed; the agent writes arrived, signed by the buyer. Each message holds the IPFS CID (content identifier) of a canonical document and its SHA-256. A record counts only if the HCS message payer is a known writer for that kind.
2. **Pre-check.** The fault rule is a fixed 12-step comparison over the six attributes (brand, size, colour, quantity, price, merchant): what was asked against what was shown, whether a change was approved, and what was shown against what was ordered, packed and received. It is a pure function in `packages/shared`; the pre-check service runs it, pins the result document and signs the finding. The hashes are public; anyone can check a document against them (the claim page's "Check a record" box hashes pasted text in the browser). The documents themselves are not on public IPFS yet: they sit in a content store on the demo host, and the status API serves them with each order's records. For a claim taken to court, the keeper also posts each record document the pre-check used, in full, as Kleros evidence on Arbitrum Sepolia, where anyone can read it (see [Disclosures](#disclosures)). The web app's "Check or file an order" page (`#/file`) re-runs the rule in the browser, on the records that API serves.
3. **Contest.** The finding names a side. If the finding is against the platform, the platform contests; otherwise the shop. The window is closed at the end of the contest period.
4. **Court.** A contested claim goes to Arbitrum by CCIP. `RecourseCase` opens a Kleros dispute in court 8, with a three-way answer (agent company at fault, shop at fault, neither) and a published policy, and the keeper posts the evidence. The court's ruling comes back as a second CCIP message.
5. **Refused ruling.** A ruling of 0 (refused) is refiled once. A second 0 counts as a ruling equal to the pre-check answer.
6. **Payout.** The settlement table is in [interfaces](docs/spec/interfaces.md), section 10. In short: the loser pays the court fee; if the platform is at fault the shop gets its net loss plus a handling amount from the platform's deposit; if the shop is at fault it gets nothing and the fee stays with the pool. A claim that never reaches a ruling can be expired after a timeout, with the fee refunded.

## How each technology is used

| Technology | What it does here | Where in the code |
|---|---|---|
| **Hedera x402 payments** | The agent pays the shop with the x402 `exact` scheme on `hedera:testnet`. On the testnet demo orders are priced and paid in HBAR, 1 HBAR per 1 USDC of list price, when `PRICE_ASSET=hbar`; unset or `usdc`, they are paid in USDC `0.0.429274`. Set it in the shared `~/.config/recourse/recourse.env`, which the shop unit, the agent commands and `ops/fund` all read, not in `shop.env`: a shop asking for HBAR from an agent that expects USDC is refused as `wrong_asset`. The agent reads the price and `payTo` from the shop's 402 response; below its spend limit it pays without a human, above it a buyer approval is needed. The spend limits are in USDC, and an HBAR amount is converted at that rate before it is compared. A public facilitator is tried first, then a second public one, then a self-hosted one. The settlement transaction id goes into the "ordered" record. | `services/shop`, `services/agent` |
| **Hedera Consensus Service** | One records topic holds the six records of every order. The pre-check and the court evidence read the topic through the mirror node and accept only messages from the right payer. | `packages/records`, `services/precheck` |
| **HTS USDC, or the testnet mock** | The platform deposit, the court-fee escrow and the shop's payout are all in the vault's token, which `deployments/hedera.json` records as `usdc.mode`; every reader takes it from that record, so one deployment never mixes tokens. In `circle` mode it is Circle's testnet USDC `0.0.429274`, used through its ERC-20 facade: the vault associates the token explicitly after deploy, and nothing moves before the mirror node shows the association. The current deployment is in `mock` mode, because Circle's faucet did not deliver: the token is `mUSDC`, a plain 6-decimal ERC-20 minted by the deployer, with no HTS token id and no mirror row, so the checks are `Vault.usdcAssociated()` and `Vault.usdc()` equal to the recorded address. With `PRICE_ASSET=hbar` the x402 order payments are in HBAR. | `contracts/src/hedera`, `contracts/script/hedera`, `contracts/src/testnet/MockUsdc.sol`, `packages/shared/src/vaultToken.ts`, `ops/lib/vault-token.sh` |
| **Chainlink CCIP, both ways** | `RecourseClaims` sends `ClaimToCourt` to `RecourseCase`; `RecourseCase` sends `RulingBack`. Each contract is its own receiver and sender, with V2 extra args, out-of-order execution on and full finality. Fees are paid in LINK (or HBAR on the Hedera side). Resend is open to anyone, capped in count and spacing, so a lost message costs a bounded amount of LINK. | `contracts/src/hedera/RecourseClaims.sol`, `contracts/src/arbitrum/RecourseCase.sol`, `contracts/src/shared` |
| **Kleros court on Arbitrum Sepolia** | `RecourseCase` creates the dispute on the live KlerosCore in court 8 (testnet), registers the dispute template, and receives the ruling through `rule`. The keeper pays the arbitration cost from the case's fee pool and posts the evidence. | `contracts/src/arbitrum`, `packages/court`, `services/keeper` |
| **Arkiv docket** | The docket service turns each ruled claim into one de-identified `case` row and keeps a monthly count per agent company and shop. With `DOCKET_STORE=arkiv`, which the running docket has used since 21:40 UTC on 6 Nov, it writes them as Arkiv entities on the Arkiv testnet (Rabdi) from one writer wallet; with `DOCKET_STORE` unset it keeps them in a local store in its own state folder (`local-store.jsonl`) instead. The docket page reads Arkiv in the browser and computes fault rates (Wilson 95% interval) there; while the docket's store is local, the page says so and shows no rates. | `services/docket`, `arkiv/`, `apps/web/src/pages/Docket.tsx` |
| **ERC-8004 identity and reviews** | ERC-8004 is a set of on-chain registries for AI agents: identity, reputation and validation. The agent companies (platforms) and the shops are registered in the identity registry (the first pair, and since the evening of 6 Nov a demo cast of three more shops and three more agent companies, each registered from its own wallet), and the agent finds the shop's x402 endpoint from its registration (`SHOP_BASE_URL` is used only when that lookup fails, `services/agent/src/setup.ts`). With `REVIEWS_ENABLED` set, the docket's scheme wallet leaves a review in the reputation registry after each case it writes; it is off on the running docket, so no review has been written. A self-review is rejected by the registry, which is why the reviewer is a separate wallet. | `packages/shared/src/abi/erc8004.ts`, `services/docket/src/reviews.ts` |

Other parts: a status API and web app (case status, filing, docket, the registered shops and agent companies), and an intake service whose only job is to tag public feedback text with an LLM. **No model decides money at any point at runtime.** Money moves only by the contracts' rules.

## Repository layout

| Path | What |
|---|---|
| `contracts/` | Foundry project: Hedera `RecourseClaims` and `DepositVault`, Arbitrum `RecourseCase`, shared types and codecs, CCIP ping contracts, deploy and wire scripts |
| `packages/shared` | Types, ids, hashing, codecs, the fault rule, status keys, address book, test vectors |
| `packages/court` | Kleros dispute template, court policy, evidence builder |
| `packages/records` | HCS record commits and reads, IPFS pinning |
| `packages/renderer` | The approval screen renderer |
| `services/shop`, `services/agent` | x402 seller and buyer |
| `services/precheck`, `services/keeper` | Fault rule runner; the machine that moves a claim between the chains |
| `services/docket`, `services/intake` | Arkiv publisher and ERC-8004 reviews; feedback tagger |
| `services/status-api`, `apps/web` | Read API and the web app |
| `arkiv/` | Arkiv usage notes: schema, query, friction, reach |
| `deployments/` | Addresses, ABIs and the wiring record per chain |
| `ops/` | Funding, wiring, service units, checks and the secret scan; `ops/cast/` sets up the demo cast and places its orders; `ops/e2e/` runs the checks against the testnet deployment and keeps each run's results; `ops/workflows/` holds each area's AI-use notes |
| `docs/` | `spec/interfaces.md` (the contract between the parts), `setup.md`, `runbook.md`, `decisions.md`, `checks.md`, `keys.md`, `ai-use.md` |

## Setup and tests

The full instructions, the settings by name and the testnet procedure are in [docs/setup.md](docs/setup.md).

Needs Node.js 22.12 or newer (`engines` in `package.json`), pnpm 12.8.1 (`packageManager` in `package.json`; `corepack enable` provides it), Foundry (`forge`, `cast`, `anvil`; the contracts pin solc 0.8.37 in `contracts/foundry.toml`), and bash, `jq`, `python3` and `flock` for the scripts. Close other heavy processes first; the tests run one package at a time and use a few hundred MB.

```
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck                              # every package, one at a time
pnpm test                                   # TypeScript tests, one package at a time
pnpm --filter @recourse/keeper test         # or a single package
pnpm --filter @recourse/web build           # the web app; the services run through tsx and have no build step
cd contracts && forge build && forge test --jobs 1   # Solidity unit, fuzz and invariant tests
```

Local runs, with nothing on a public network:

```
pnpm --filter @recourse/agent local-demo                 # one whole order on this machine, from the records to a filed claim
pnpm --filter ./services/keeper test:anvil               # the keeper on two anvils with a local CCIP relay
bash contracts/script/hedera/hedera.sh rehearse <port>   # Hedera deploy-to-lock on one anvil
bash ops/wire/rehearse.sh                                # both deploys and every wiring step on two anvils
bash ops/units/install.sh --verify                       # validates the service unit files
```

The local runs use a mock USDC, a mock arbitrator and the CCIP local simulator; `local-demo` also uses an in-memory HCS topic and a simulated facilitator, so no money moves. They write only `*.local.json` files, which are git-ignored.

On the testnets: settings go in `~/.config/recourse/recourse.env` (the shared names in [.env.example](.env.example), the rest in [docs/setup.md](docs/setup.md#settings); values never in git) and each role's key in its own Foundry keystore ([docs/keys.md](docs/keys.md)). The contracts are deployed and wired by `contracts/script/hedera/hedera.sh`, `contracts/script/arbitrum/deploy.sh` and the steps in `ops/wire/`, each a dry run until given `--broadcast` or `--send`, and the services run as systemd user units (`bash ops/units/install.sh --install`, then `bash ops/units/ctl.sh start`; see [docs/runbook.md](docs/runbook.md)). Every service reads the contract addresses from `deployments/hedera.json` and `deployments/arbitrum.json`.

## Open-source libraries

Read from the `package.json` files and `contracts/remappings.txt`; the versions are the pinned ones.

| Library | Version | Licence | Used for |
|---|---|---|---|
| viem | 2.57.8 | MIT | every contract read and write from TypeScript, on both chains |
| @hiero-ledger/sdk (the Hedera SDK) | 2.85.0 | Apache-2.0 | HCS record messages, Hedera transaction signing, the shop's self-hosted facilitator |
| @x402/core, @x402/hedera, @x402/express, @x402/fetch | 2.28.0 | Apache-2.0 | x402 `exact` payments on `hedera:testnet`: the shop's paid endpoint and the agent's paying client |
| @kleros/kleros-sdk | 2.4.0 | MIT | checking the Kleros dispute template (`packages/court`) |
| @kleros/kleros-v2-contracts | 0.12.0 | MIT | the arbitrator, arbitrable and evidence interfaces `RecourseCase` uses |
| @chainlink/contracts-ccip | 2.0.0 | BUSL-1.1 for the package; the three files imported (`Client.sol`, `IRouterClient.sol`, `CCIPReceiver.sol`) are MIT | CCIP send and receive in `RecourseClaims` and `RecourseCase` |
| @chainlink/local | 0.3.1 | MIT for the package; its `CCIPLocalSimulator.sol` is BUSL-1.1 and `LinkToken.sol` is UNLICENSED | the CCIP local simulator, in Solidity tests only |
| @chainlink/contracts | 1.5.0 | BUSL-1.1 | only through @chainlink/local, in tests |
| @chainlink/ccip-cli | 1.16.1 | MIT | declared as a dev tool; no script uses it |
| @openzeppelin/contracts | 5.6.1, plus 5.3.0 and 4.8.3 for the Chainlink packages | MIT | ownership, safe ERC-20 calls, reentrancy guards, the mock token |
| forge-std | 1.17.0 | MIT OR Apache-2.0 | Solidity tests and scripts |
| @arkiv-network/sdk | 1.0.1 | MIT (its `LICENSE.md`; its `package.json` names none) | the docket's Arkiv store and the web app's Arkiv reads |
| @aws-sdk/client-s3 | 3.1155.0 | Apache-2.0 | Filebase pinning through its S3-compatible API (not configured on the demo) |
| @ipld/car, multiformats | 5.4.7, 14.0.5 | Apache-2.0 OR MIT | CIDs and CAR packing for record documents |
| express | 5.3.0 | MIT | the services' HTTP servers |
| zod | 3.25.76 | MIT | the shop's order validation |
| react, react-dom | 19.3.1 | MIT | the web app |
| vite, @vitejs/plugin-react | 8.3.5, 6.1.2 | MIT | the web app's build and dev server |
| vitest | 5.0.5 | MIT | TypeScript tests |
| typescript | 7.0.2 | Apache-2.0 | type checking |
| tsx | 4.23.15 | MIT | runs the TypeScript services and scripts without a build step |

The `@types/*` packages (MIT) supply type definitions only.

## Owner powers and spend paths

The deployer key owns all three contracts (two-step ownership transfer only). Each contract has a one-way `lockConfig`; the tables show what is possible before and after it. After the lock the owner can configure only the settings marked "yes" in the right-hand column, and none of them decides a claim. **Before the lock it can decide claims**: on `RecourseClaims` it can make itself the pre-check signer (`setPreCheckSigner`) and sign any finding, switch to a one-leg bridge mode with itself as the ruling relayer (`setBridgeMode`) and record any ruling, or point `setPeer` at a contract it controls and send a ruling back over CCIP; `settle`, which anyone may call, then pays from the platform's deposit. On 6 Nov 2026 none of the three contracts is locked (`configLocked()` and `locked()` read false), and the deployer keystore sits on the host that runs the services, including the two reached through public tunnels ([ops/units/README.md](ops/units/README.md#what-a-unit-can-see)). Until the lock, treat every claim as decided at the deployer's discretion.

### `RecourseClaims` (Hedera)

| Power | Before lock | After lock |
|---|---|---|
| `setPeer` (the court contract), `setParams`, `setPreCheckSigner`, `setBridgeMode` (and the relayer) | yes | no |
| `sweepLink`, `sweepNative` (move this contract's LINK or HBAR out) | yes | no |
| `setExtraArgs` (CCIP gas for later sends) | yes | yes |
| `setFeeToken` (LINK or HBAR for CCIP fees) | yes | yes |
| `lockConfig` | once | |

The owner cannot change a finding or ruling once it is recorded, file a claim for a shop, or move the vault's USDC itself; before the lock it can still choose who records the findings and rulings of claims not yet decided, as above. Trusted roles: the **pre-check signer** is the one trusted step (it signs the finding; the record hashes are public, so anyone can check a document against them and re-run the rule on documents that match, and a wrong finding can be contested). The **ruling relayer** can record rulings only in the one-leg modes; in the default two-way mode that call is refused, and only the owner can change the mode, before the lock.

Spend paths: LINK or HBAR leaves for CCIP fees only, through `sendToCourt` and `resend` (permissionless, at most `maxSends` per claim and `resendGap` apart), and through `sweepLink` and `sweepNative` before the lock. No function accepts USDC.

### `DepositVault` (Hedera)

| Power | Before lock | After lock |
|---|---|---|
| `bindClaims`, `setParams` (top-up window, exit delay, minimum deposit) | yes | no |
| `setRequired(platform, amount)` (the deposit a platform must hold to be in good standing) | yes | yes |
| `lockConfig` | once | |

Spend paths: USDC leaves the vault only by `applyOutcome` (callable only by Claims, from its settle and close paths), by `withdrawCredit` (the shop or pool collecting its own credit), and by a platform's own `exit` after `requestExit` plus the exit delay, with no open claims. The owner cannot withdraw. `setRequired` can raise a platform's requirement, which can put it out of good standing and stop shops accepting its orders, so it is disclosed here as a live owner power.

### `RecourseCase` (Arbitrum Sepolia)

| Power | Before lock | After lock |
|---|---|---|
| `setPeer` (the Hedera claims contract), `setParams` (case deadline, open-case cap, resend gap, max sends), `setTrustedRelay` | yes | no |
| `sweepLink` | yes | no |
| `setExtraArgs` (CCIP gas for rulings; must be non-zero), `setPolicyURI` (must be an `/ipfs/` path), `setTemplateText` | yes | yes |
| `withdrawFeePool` (the team's arbitration money) | yes | yes |
| `lockConfig` | once | |

The owner cannot change or invent a ruling (only KlerosCore calls `rule`), cannot open a case without a stored claim, and cannot take ETH except through `withdrawFeePool`. `setTrustedRelay` is off by default; when set, that one address may submit a claim without CCIP, a disclosed trusted step. The template and policy changes affect only later cases.

Spend paths: ETH leaves through `openCase` and `refile` (exactly the live Kleros arbitration cost, at most two disputes per claim) and `withdrawFeePool` (owner only); ETH attached to `relayRuling` pays exactly the CCIP fee and the surplus goes back to the caller, or into the pool if the caller cannot take it. LINK leaves through `relayRuling` (permissionless, exactly the quoted fee, at most five sends per claim, 30 minutes apart, so the worst LINK loss per claim is five fees) and `sweepLink` before the lock. Plain ETH sends revert. `maxOpenCases` caps open disputes, and because opening and resending are permissionless, third parties can fill that cap.

### Keys

Ten roles, each with its own Foundry keystore kept outside the repo ([docs/keys.md](docs/keys.md) lists names and public addresses, never values). The deployer owns the contracts; `ops-hedera` and `ops-arb` run the keeper and top-ups; the others are service identities. The demo cast's nine identities (three shops, three agent companies and their three agents) each have a Foundry keystore of their own in the same folder, made by `ops/cast/setup.ts` ([ops/cast/README.md](ops/cast/README.md#keys)).

## What is live and what is not

| Part | State |
|---|---|
| Solidity contracts (Claims, Vault, Case) | Written. Unit, fuzz and invariant tests pass locally. DepositVault (`0.0.11336129`) and RecourseClaims (`0.0.11336130`) are deployed on Hedera testnet on a testnet mock USDC (`mUSDC`), because Circle's testnet USDC faucet did not deliver; config not locked yet; see `deployments/hedera.json` (`usdc.mode` is `mock`, with the mock's address). The first deployment (`0.0.11329716`, `0.0.11329717`, on Circle USDC `0.0.429274`) is retired and listed in `deployments/retired.json`. RecourseCase (`0xd7f11FA06A97a45a6Af03c71d7eB3219C1a703B8`) is deployed on Arbitrum Sepolia; see `deployments/arbitrum.json`. None of them has been redeployed since the morning of 6 Nov, so every contract change committed after the deploy is in the source only and not on chain: among them R04 (`ece7d36`), R47 (`108adcf`), R01's earlier cut-off (`f294d80`), the case-timing changes in `848f987` and the filing-order payouts in `dd3c7f7` ([Known limits](#known-limits)). |
| Deploy and wiring scripts | Written and rehearsed on local anvils. The Hedera deploy, USDC association and parameter steps have run on testnet, and so has the Arbitrum deploy. `deployments/wiring.json` lists the wiring steps run through the scripts; its first Hedera rows were sent to the retired claims contract and are marked `retired`. The replacement claims contract was wired outside the scripts (its peer, its LINK, and RecourseCase repointed to it in `0x0bf1a1f62c9a62066128d31de5a26e637b2616044d4c93ddee6b5bc3d4ad1e8f`, see `deployments/retired.json`). |
| TypeScript services (shop, pre-check, keeper, docket, intake, status API) | Running on one host against Hedera testnet and Arbitrum Sepolia, as systemd user units ([ops/units/README.md](ops/units/README.md)). The buying agent has no long-running service; it places one order per run from the command line. |
| Web app | Built and served from the same host by `recourse-web`, reached through a Cloudflare quick tunnel. A quick tunnel's name changes on every restart, so no URL is pinned here; `bash ops/units/ctl.sh urls` prints the current one. Besides the claim, party, docket, file and cast pages it serves `#/story` (one claim told in five steps, read from the status API), `#/join` (a shop registers on ERC-8004 from its own wallet) and `#/bond` (an agent company registers, sizes and posts its deposit, and every agent company's bonded mark is read from the vault); a new identity still needs the operator to add it to the party map, and only the operator can mint mUSDC and set a required deposit. |
| Orders and claims | Twelve x402 payments have settled on Hedera testnet in HBAR through the x402.org facilitator on 6 Nov, all listed below: a 0.1 HBAR connectivity payment and three demo orders by 17:20 UTC, the first order of each of the test runs 2, 2b and 2c (20:49, 21:10 and 21:36 UTC), and the demo cast's five orders (21:25 to 21:35 UTC). The wrong sizes in the payout case, the demo cast's payout claim and the second court case are staged: `live-order --fault` makes the agent write an ordered record that differs from what it showed, and the shop ships what was ordered. Six claims have been filed. On the first claim the pre-check answered 3 ("neither": the agent's mandate had approved the size change the claim was about), nobody contested within the window, and the keeper closed the claim; the 1 mUSDC court fee went back to the shop as credit, which the shop withdrew. A second claim (`0x392d6f13…7f3c50`, on the second demo order, paid by the third payment) was also pre-checked 3; the shop contested it, it went to Arbitrum over CCIP and became Kleros dispute 212, and the court ruled 3 ("neither"). The ruling came back over CCIP and the keeper settled the claim on Hedera on 6 Nov at 11:10 UTC: nothing was owed, and the shop's 1 mUSDC court fee was kept by the pool. The third claim is the payout case (`0x8f78143e…6f75`, on the third demo order, paid at 17:20 UTC; asked and shown size M, ordered, packed and arrived size L): filed at 19:23 UTC, pre-checked 1 (the agent company at fault, gap 2: shown against ordered) at 19:24, not contested by the end of the window at 19:34, and closed by the keeper at 19:35 UTC, when the vault paid 2.575 mUSDC from Parcel Minds' deposit (the 1.5 basket plus 1.075 handling) and refunded the 1 mUSDC court fee; the shop withdrew its 3.575 mUSDC credit at 19:37 UTC. The fourth and fifth were filed by the demo cast's Kestrel Outfitters against Wren Errands: `0xf5eee258…8c69` (asked and shown M, ordered S) was pre-checked 1 and closed uncontested at 21:36 UTC, paying 3.1 mUSDC from Wren Errands' deposit (2 basket plus 1.1 handling); `0x31002c8d…139c` (the agent showed L for an asked M and its mandate approved the change) was pre-checked 3 and closed uncontested at 21:41 UTC. Both court fees were refunded, and Kestrel withdrew its 5.1 mUSDC credit at 21:55 UTC. The sixth claim, `0x00ad6c98…feae`, is the second one taken to court (see the Kleros row). The other cast orders and the orders of test runs 2b and 2c have no claim. |
| Funding | Testnet funds only. On the evening of 6 Nov the deployer held about 464 HBAR, `ops-hedera` about 203 HBAR, the agent about 196 HBAR and the shop about 39 HBAR; the deployer gave the nine demo-cast accounts 33.5 HBAR in all to start with. On Arbitrum Sepolia the deployer and `ops-arb` hold test ETH and RecourseCase's fee pool, funded with 0.01 ETH for Kleros fees, held 0.00919 ETH after dispute 212 and also paid dispute 213's arbitration cost; RecourseCase holds no LINK, so the keeper pays the ruling's CCIP fee in ETH from `ops-arb`. The claims contract holds test LINK for CCIP fees (`ops/wire/12-set-fee-token.sh` switches it between LINK and HBAR). Circle testnet USDC was requested for the platform, shop and agent and never arrived; the vault's `mUSDC` is minted by the deployer, the mock's owner. Deposits in the vault (mUSDC, read through the status API at about 22:00 UTC): Parcel Minds 15.425 against 18 required, after paying 2.575 in the payout case; Wren Errands 6.9 against 10, after paying 3.1; Tallyhouse Procurement and Lumen Metrics 10 each against 10 (posted at setup). Parcel Minds and Wren Errands are below their required amount and read as in good standing until their top-up deadline. With orders paid in HBAR (`PRICE_ASSET=hbar`) the agent needs no USDC; its HBAR floor is then 8 (`ops/fund/lib.sh`). |
| CCIP lanes | Public lanes exist on both testnets and the peers are set both ways. Four messages so far, all executed: for claim `0x392d…`, `ClaimToCourt` to Arbitrum (sent 09:07 UTC on 6 Nov, executed within a minute) and `RulingBack` to Hedera (sent 10:51 UTC, executed 11:10 UTC); for claim `0x00ad…`, `ClaimToCourt` to Arbitrum (sent 21:52 UTC, received 21:53 UTC) and `RulingBack` to Hedera (sent 23:04 UTC, executed 23:23 UTC). |
| Kleros disputes | Dispute 212 in court 8, opened by RecourseCase on 6 Nov at 09:08 UTC with the order records as evidence, ruled 3 ("neither") at 10:43 UTC, and executed at 10:51 UTC. Dispute 213 in court 8, for the second claim taken to court (`0x00ad6c98…feae`, on test run 2's order `0x042fcd28…f27f`, paid at 20:49 UTC; asked and shown size M, ordered, packed and arrived size L): the claim was filed at 21:43 UTC, pre-checked 1 (the agent company at fault) at 21:45, and contested by the agent company at 21:50 UTC, sent with Foundry's `cast send` from the platform's keystore because the status API's contest build timed out on the slow Hedera relay; it crossed to Arbitrum over CCIP, RecourseCase opened the dispute at 21:55 UTC, and the keeper posted the order records as evidence at 21:56 UTC; the dispute moved from its evidence period to the commit period by 22:13 UTC and to the vote period by 22:23 UTC. The juror's vote gave ruling 1 (the agent company at fault) and the vote period closed by 22:34 UTC; with no appeal, the ruling was executed and relayed at 23:04 UTC. |
| Arkiv docket | Since 21:40 UTC on 6 Nov the docket writes to the Arkiv testnet (Rabdi, chain id 7794095; `DOCKET_STORE=arkiv`) from the scheme wallet `0x54E4545AFcf8960884A750320e70aFE16b2b3CaE`. It has written two ruled cases, dispute 212's as entity `0x53b34e252b3f329dbe2df1a45cb686f191b98a011fe1a0166db839296491bd02` and dispute 213's (ruling 1, 3.575 mUSDC to the shop) as entity `0x0dac6604619852eed08edccbaed9c1a979af627cc62b97cd581830828b6c4053`, and the November monthly counts as two entities, one per agent company and shop pair (Parcel Minds and Halden Supply, Wren Errands and Kestrel Outfitters); claims closed without a ruling appear only in the monthly counts. The docket page reads these entities from Arkiv in the browser. The query for the case entities is in [arkiv/readme-section.md](arkiv/readme-section.md): `arkiv.schema = str('case') AND tier = str('ruled') AND $owner = addr(0x54E4545AFcf8960884A750320e70aFE16b2b3CaE) ORDER BY settledAt:u64 DESC`; it returned both case entities when checked at 23:35 UTC on 6 Nov. |
| ERC-8004 identities | Registered in the identity registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` on Hedera testnet: agent 149 is the platform ("Parcel Minds"), agent 150 the shop ("Halden Supply"); on the evening of 6 Nov agent 149 updated its registration with its type ("General shopping agent"). The demo cast added three shops, Kestrel Outfitters (171), Fernhill Market (172) and Quillon Data (173), and three agent companies, Wren Errands (174), Tallyhouse Procurement (175) and Lumen Metrics (176), each registered from its own wallet between 20:47 and 21:08 UTC on 6 Nov; each cast agent company also posted a 10 mUSDC deposit. In three of the cast's five orders the agent found the shop's x402 endpoint through the shop's registration; the other two ran the shop in the same process. No review has been written: reviews are off on the running docket (`REVIEWS_ENABLED` defaults to off). |
| Source verification | Verified on Sourcify (6 Nov, 17:08-17:24 UTC). On Hedera testnet (chain 296), DepositVault, RecourseClaims and MockUsdc have an exact runtime match, built from commit `5275e74`; Sourcify has no creation-bytecode match for them. On Arbitrum Sepolia, RecourseCase has an exact match of both creation and runtime bytecode, built from `614403e`. Not verified: RecourseCase on Arbiscan (no Arbiscan API key), and the retired first Hedera deployment (no Sourcify match). |
| Random sampling and billing | Designed, not built. In the design only a random share of contested claims (p = 0.25, drawn with Hedera's PRNG system contract) goes to court, the rest close with the court fee refunded, the docket weights each sampled ruling by 1/p, and the agent company is billed for undrawn claims at its sampled fault rate. On the deployed `RecourseClaims`, `batchOf` always returns 0, so every contested claim goes to court and nothing is billed. The docket's rate maths already takes the weights (each is 1 today). See [docs/judges-faq.md](docs/judges-faq.md) and Known limits R65. |


What is mocked in tests and local runs, which deploy their own mocks: HTS and the PRNG system contract, the USDC token, the CCIP router (a local simulator with a relay that can drop and delay), and KlerosCore (a mock arbitrator that accepts a chosen ruling). One mock is live: the testnet demo's current Hedera deployment runs on a testnet mock USDC (`mUSDC`, "Mock USD Coin (testnet)", 6 decimals, minted only by its owner) because Circle's testnet USDC faucet did not deliver to our accounts. It is not Circle's token and is worth nothing; the status API and the web app label its amounts "mUSDC (testnet mock)". The first deployment, on Circle USDC, is retired and listed in `deployments/retired.json`. Order payments (x402) are in HBAR and never touch the vault token. Nothing in this repository fabricates a ruling, a payment or a transaction hash for display.

## Deployed addresses and transactions

Taken from `deployments/`, `deployments/wiring.json`, `deployments/parties.json`, `packages/records/h0-ids.json`, the Hedera mirror node, the status API's chain reads (`GET /v1/claims/<id>`, `GET /v1/cast`), the docket service's reads, Sourcify, and the output of the `ops/cast` and `live-order` runs. All testnet.

| Item | Chain | Address or id | Transaction | Explorer | Source verification |
|---|---|---|---|---|---|
| `DepositVault` | Hedera testnet | `0.0.11336129` (`0xA22fB188b49eddecc4f9DE22607e70E1d07Aea2e`) | `0x05923a8a3abcf2988ff7b1c3ea29bfedcf0f8c6df18a71e23b314c4f26bce11d` | [HashScan](https://hashscan.io/testnet/contract/0.0.11336129) | Sourcify, exact runtime match ([Sourcify](https://repo.sourcify.dev/296/0xA22fB188b49eddecc4f9DE22607e70E1d07Aea2e)) |
| `RecourseClaims` | Hedera testnet | `0.0.11336130` (`0xc4d457991eE42438EA433773e491ba8F2B27dDee`) | `0x1196cbc22c60db8cfe6443ba51bae809a4a8c7e106545e739071ea3f488a1d53` | [HashScan](https://hashscan.io/testnet/contract/0.0.11336130) | Sourcify, exact runtime match ([Sourcify](https://repo.sourcify.dev/296/0xc4d457991eE42438EA433773e491ba8F2B27dDee)) |
| `MockUsdc` (`mUSDC`, the vault token) | Hedera testnet | `0x6D6fb82e82E525B9c30619189EA8aF17117C3c73` | `0x14005c3a5027eb101c99528d990ee1b2ff6d53f6de60a3aee196fe34cb6801e0` | [HashScan](https://hashscan.io/testnet/contract/0x6D6fb82e82E525B9c30619189EA8aF17117C3c73) | Sourcify, exact runtime match ([Sourcify](https://repo.sourcify.dev/296/0x6D6fb82e82E525B9c30619189EA8aF17117C3c73)) |
| `RecourseCase` | Arbitrum Sepolia | `0xd7f11FA06A97a45a6Af03c71d7eB3219C1a703B8` | `0x21695fedbc3d8d91c15c651eb8ae8ed747adf356182038b437b64633b00e6492` | [Arbiscan](https://sepolia.arbiscan.io/address/0xd7f11FA06A97a45a6Af03c71d7eB3219C1a703B8) | Sourcify, exact creation and runtime match ([Sourcify](https://repo.sourcify.dev/421614/0xd7f11FA06A97a45a6Af03c71d7eB3219C1a703B8)); not verified on Arbiscan |
| HCS records topic | Hedera testnet | `0.0.11335218` | `0.0.11329551@1793945456.221613303` | [HashScan](https://hashscan.io/testnet/topic/0.0.11335218) | n/a |
| ERC-8004 agents 149 (platform), 150 (shop) | Hedera testnet | registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0xea5d875c0d3ac84055636ee4f082a8bfe3acb495885e5baf32f2e8ef8c5eaa64`, `0xd7e03c68f1240111c45d7af8d5a581614ce234a3a0a29ae93c8b91bc7ae5314a` | [HashScan](https://hashscan.io/testnet/contract/0x8004A818BFB912233c491871b3d84c89A494BD9e) | n/a |
| ERC-8004 agent 149's registration updated with its type ("General shopping agent", `setAgentURI`, 6 Nov evening) | Hedera testnet | registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x18eebd36172472a68adb2a5ae208f46184b885a57f55368420b2d0c4df38a251` | [HashScan](https://hashscan.io/testnet/transaction/0x18eebd36172472a68adb2a5ae208f46184b885a57f55368420b2d0c4df38a251) | n/a |
| First settled x402 payment (0.1 HBAR, agent `0.0.11329682` to shop `0.0.11329680`) | Hedera testnet | n/a | `0.0.9185802@1793949477.114377745` | [HashScan](https://hashscan.io/testnet/transaction/1793949483.409917104) | n/a |
| First demo order payment (1.5 HBAR, same accounts) | Hedera testnet | order `0x1bf80d52b5b114f4318d40259c3bc2990db86f8e82a5101abafb337f4f3ad802` | `0.0.9185802@1793954349.706075765` | [HashScan](https://hashscan.io/testnet/transaction/1793954357.635329575) | n/a |
| Second demo order payment (1.5 HBAR, same accounts; the order of the claim taken to court) | Hedera testnet | order `0xb7da5ace588084b3bfb85062d4f17f18137e5572917158432b14df0f9ed8c428` | `0.0.9185802@1793955935.573660355` | [HashScan](https://hashscan.io/testnet/transaction/1793955942.069785771) | n/a |
| Third demo order payment (1.5 HBAR, same accounts, 17:20 UTC; the order of the payout case) | Hedera testnet | order `0x6d94a648b3baecd5497adb542dcaaed82aa007d92c2b891acec0608d1a769274` | `0.0.9185802@1793985607.160449829` | [HashScan](https://hashscan.io/testnet/transaction/1793985622.013190058) | n/a |
| First claim: filed, pre-checked, closed uncontested | Hedera testnet | claim `0x9cd704684c56a0ba1ff17ba9765d7c1e8521e78a3d0a4bbe7935d5a2a87e412c` | `0x8b1c0ace74283adc097c8f557b4adffaac2dcab530467d58b92a50612297c789`, `0x2c8d558a26cd071e74cac125179fc51b592c83f9bd3af96db2a7bf69b37a1deb`, `0x243c3b5403d70a87dc78713ab337e97386c2ea37683fcb87245b68d58f3e9665` | [HashScan](https://hashscan.io/testnet/contract/0.0.11336130) | n/a |
| First claim taken to court: filed, pre-checked, contested, sent | Hedera testnet | claim `0x392d6f13cdf5fe1ca93289d143e51b511f333de3d6d1769c72ddd0039c7f3c50` | `0xb0486c1e1cec26ef8910dceb092888e00ad2f798590531f36fe56ceb99679776`, `0x22454f7e9df75d5052a39a8c7cfa0a74c3696ebaf9f6e75d6adcd40621990810`, `0xd4b1351daa9bf82b3bc6bf086b80e7117e7e84cda66ea20e1db3d33f6453fec3`, `0xcf5236a69f8c8a0d8c4d537993692e41bdd4194ba2b2027eaea0037bebe933c4` | [HashScan](https://hashscan.io/testnet/contract/0.0.11336130) | n/a |
| First CCIP message to Arbitrum (`ClaimToCourt`) | Hedera to Arbitrum Sepolia | message `0x6631dc70a8a954c4e442cb8104af8d5c45b2117724d6deea096e9a8d6bc60adc` | sent in `0xcf5236a6…e933c4`, received in `0x27555711edfb76427d17b791aec8bc25c6ab7e70a33e19588aa9e662da3bd7db` | [CCIP Explorer](https://ccip.chain.link/msg/0x6631dc70a8a954c4e442cb8104af8d5c45b2117724d6deea096e9a8d6bc60adc) | n/a |
| First Kleros case | Arbitrum Sepolia | dispute 212, court 8 (template 194) | opened `0x993c49af2b77ed0710c5e3f5d17efc9789e80333a488ca3f894058ae6eb83a42`, evidence `0x6c97c6c8ff46997e118d7531410861324bc6f98dc92c3f01fb4223abdf4f9959`, ruling executed `0xeebfe2fea6267ecc3acbdc30a6ab74981ed653b4efba12c0abae86f06e41d417` | [Kleros](https://v2-testnet.kleros.builders/#/cases/212/overview) | n/a |
| First CCIP message to Hedera (`RulingBack`) | Arbitrum Sepolia to Hedera | message `0xbc0bb5f319c9045d70576b7a906c84b149a10c6de6638eda8eb4148e29d52ff3` | sent in `0x6d471236aac5149728e96e977fc492ff2b5536fefeb8c545bf121e29a8f13c0d` (fee in ETH), received in `0x33363440caab6fe0719e806d4bf2ce132673208d7e3280ca4d426d96dc3f15c3` | [CCIP Explorer](https://ccip.chain.link/msg/0xbc0bb5f319c9045d70576b7a906c84b149a10c6de6638eda8eb4148e29d52ff3) | n/a |
| First court case settled: ruling 3 applied, nothing owed, court fee kept by the pool | Hedera testnet | claim `0x392d6f13cdf5fe1ca93289d143e51b511f333de3d6d1769c72ddd0039c7f3c50` | `0x502db49f52f56bb2e1f014277139ccf140344186e6a5f257a9c59d7b9d90bd40` | [HashScan](https://hashscan.io/testnet/contract/0.0.11336130) | n/a |
| First credit withdrawn (claim `0x9cd7…412c`'s 1 mUSDC, to the shop) | Hedera testnet | vault `0.0.11336129` | `0x082d0148c6773a8c6f0b4e62db4a9cb28d88e6d41285380728a428cb3b57f050` | [HashScan](https://hashscan.io/testnet/contract/0.0.11336129) | n/a |
| Payout case records: asked, shown, approval, ordered, packed, arrived (order `0x6d94a648…9274`) | Hedera testnet | topic `0.0.11335218`, messages 13 to 18 | n/a | [HashScan](https://hashscan.io/testnet/topic/0.0.11335218) | n/a |
| Payout case: filed, pre-checked 1 (agent company at fault), closed uncontested, 2.575 mUSDC paid from Parcel Minds' deposit | Hedera testnet | claim `0x8f78143ea47bd370edb87e91a720955110aa4978d79474a5d5fbbf0d1eec6f75` | approve `0xf1f1d27f1143f03adc9e91c97993b6bec70aeebcec5f467a3f3ff0f6bc1dda3e`, fileClaim `0x0c017f676e3bae04eb987404e4f654835c6817d4f9a0e350de0bd3596a331cb4`, recordPreCheck `0x562b5a5a59ba3bb7f24733b969967a55c4b4ce1c0b7c13f83ee5a6f280ecb5fd`, closeUncontested `0xd9f25361bca6c62a7afd671ece35c38dcfc7d0e8a4ef884165a1a7fec48425c7` | [HashScan](https://hashscan.io/testnet/transaction/0xd9f25361bca6c62a7afd671ece35c38dcfc7d0e8a4ef884165a1a7fec48425c7) | n/a |
| Payout withdrawn (the payout case's 3.575 mUSDC credit, to the shop) | Hedera testnet | vault `0.0.11336129` | `0xb08f494f57e4e1abf85e7688e29a61e6812c0b7e58bf49d7d89e2fbd38b81539` | [HashScan](https://hashscan.io/testnet/transaction/0xb08f494f57e4e1abf85e7688e29a61e6812c0b7e58bf49d7d89e2fbd38b81539) | n/a |
| 10 mUSDC minted to Parcel Minds' wallet (20:13 UTC) for the test runs' deposit top-up, a step no run reached, so no top-up was posted | Hedera testnet | token `0x6D6fb82e82E525B9c30619189EA8aF17117C3c73` | `0x0d4226247356b70fc1728277cf18231f205fca04079844bb90af4fbc62cd567a` | [HashScan](https://hashscan.io/testnet/transaction/0x0d4226247356b70fc1728277cf18231f205fca04079844bb90af4fbc62cd567a) | n/a |
| Test run 2's order payment (1.5 HBAR, agent `0.0.11329682` to shop `0.0.11329680`, 20:49 UTC; the order of the second claim taken to court) | Hedera testnet | order `0x042fcd28f1e2d9a0cbdba70c98c52ee7f36a3a7db5a47f2c8665bf41708ff27f` (topic messages 19 to 24) | `0.0.9185802@1793998164.280634466` | [HashScan](https://hashscan.io/testnet/transaction/1793998177.315006241) | n/a |
| Test run 2b's order payment (1.5 HBAR, same accounts, 21:10 UTC; approve sent, no claim filed) | Hedera testnet | order `0xe1eeb65da05f4d6a15c780a845d4ec830ab10d84907976ba91c967ed6d880c53` (topic messages 25 to 30) | `0.0.9185802@1793999438.678871182`; approve `0x4913557f854a80b9931464f0613bfe67d5c14aeb8dd0c3f354d2b099a3dcba09` | [HashScan](https://hashscan.io/testnet/transaction/1793999446.797922104) | n/a |
| Test run 2c's order payment (1.5 HBAR, same accounts, 21:36 UTC; no claim filed) | Hedera testnet | order `0xa876ad49c2d0c88c3018aa436797e497aad7a2f41f5cf051eeee694fe7c463d6` (topic messages 58 to 63) | `0.0.9185802@1794001003.072375295` | [HashScan](https://hashscan.io/testnet/transaction/1794001007.746509143) | n/a |
| Demo cast Hedera accounts (nine, created by the deployer `0.0.11329546`) | Hedera testnet | Kestrel Outfitters `0.0.11345369`, Fernhill Market `0.0.11345370`, Quillon Data `0.0.11345372`, Wren Errands `0.0.11345374` and its agent `0.0.11345375`, Tallyhouse Procurement `0.0.11345377` and its agent `0.0.11345379`, Lumen Metrics `0.0.11345380` and its agent `0.0.11345381` | `0.0.11329546@1793997356.659902369`, `0.0.11329546@1793997362.750400774`, `0.0.11329546@1793997366.455896822`, `0.0.11329546@1793997371.815919336`, `0.0.11329546@1793997377.768808281`, `0.0.11329546@1793997383.272748320`, `0.0.11329546@1793997387.202948043`, `0.0.11329546@1793997393.195585336`, `0.0.11329546@1793997399.560627932` | [HashScan](https://hashscan.io/testnet/account/0.0.11329546) | n/a |
| ERC-8004 agent 171, shop Kestrel Outfitters | Hedera testnet | wallet `0xb4C740B6774c79EeCD37775F61fbD509ED76C042` | registered `0x34caea3e96c4ffe3f5328e93834b51b66b9cb92e99e48187fb74c21733a79e6d`; 3 mUSDC minted for court fees `0x35def2da229f38ec8eebd009473a60ecc24f37d6d61a6edb14659dcde9afe668` | [HashScan](https://hashscan.io/testnet/transaction/0x34caea3e96c4ffe3f5328e93834b51b66b9cb92e99e48187fb74c21733a79e6d) | n/a |
| ERC-8004 agent 172, shop Fernhill Market | Hedera testnet | wallet `0x980c2FEe3C8F5E9221688A372B3ECD81D1984baB` | registered `0x9a5a0bf2120a16da054b28c546220fbf1a8ce9dfd43423599869d7590bd592cf`; 1 mUSDC minted for court fees `0x408da4fe140613c6e0cf2ba0516834fa862ad89c858415cdfd6aca3489f5f198` | [HashScan](https://hashscan.io/testnet/transaction/0x9a5a0bf2120a16da054b28c546220fbf1a8ce9dfd43423599869d7590bd592cf) | n/a |
| ERC-8004 agent 173, shop Quillon Data | Hedera testnet | wallet `0x2B0F99829Ee41c5e23bb378be36672c2564223d3` | registered `0xa54827b90a4b8f3ae59ba44c1e62fd9ac15697072076b55fc330f6815e82a4d2`; 1 mUSDC minted for court fees `0x45c33fa283e19926168114ec1c9027ea15d4b3c15026e2f7f845e10da2fcddab` | [HashScan](https://hashscan.io/testnet/transaction/0xa54827b90a4b8f3ae59ba44c1e62fd9ac15697072076b55fc330f6815e82a4d2) | n/a |
| ERC-8004 agent 174, agent company Wren Errands | Hedera testnet | wallet `0x5bdda3774E8D25d9B96e2a032aeaeD91aB1b7C04` | registered `0x1495992e1e8a388938fe2636b687c9060e9767cb50efdddddd2d8eb3fe29d312`; 10 mUSDC minted `0x325587cc53ca3594f8cfeb5c1810a46ba25b72031602879aff8be06c7cd157ad`, deposit posted `0x479bc951bf4bb2310edda6337365d5b2dc2fdf02c9b16aa442d3c2f762fb2a0a`, required deposit set to 10 mUSDC `0xec58af0e6962dffde4b29254210ce8b418f504cf07f81493d9c8aeef727e7d32` | [HashScan](https://hashscan.io/testnet/transaction/0x1495992e1e8a388938fe2636b687c9060e9767cb50efdddddd2d8eb3fe29d312) | n/a |
| ERC-8004 agent 175, agent company Tallyhouse Procurement | Hedera testnet | wallet `0x9fA8b40E2d31EBe2249077a38a3ca5Cf570c4173` | registered `0x3e1168da393c205a6205f33b92f5fb4479ab303d7a58e17f5fd77965d00108d4`; 10 mUSDC minted `0xb25d95ac4d33af305065d456828c623caf2c13ca4e6df7a7e5a0054df30619ce`, deposit posted `0x58bf478988338f0a0813656178c3e1e71f8b8d30bc6c6a55cfe229f9c7a48ee5`, required deposit set to 10 mUSDC `0xd75a8df7e12da3a3c2c9c84db099e58f5a37d689469bb295569a2b4ea2defa43` | [HashScan](https://hashscan.io/testnet/transaction/0x3e1168da393c205a6205f33b92f5fb4479ab303d7a58e17f5fd77965d00108d4) | n/a |
| ERC-8004 agent 176, agent company Lumen Metrics | Hedera testnet | wallet `0x62504F96e82A095c87A34912cC6cE11ec00F4bBb` | registered `0xf19c8eec304ac6ac619ed857d67bbca534ca1dc57e2599d172d5e48f30931678`; 10 mUSDC minted `0x31693b0b84c5a7e1346b8833ac029ae0f9a453c8ac214a4ff968e4c6895f2b41`, deposit posted `0xf1586ede7d7f8b6abedda6f7057f5816bb3ea3a1bd5744af0deb413ea92fe42a`, required deposit set to 10 mUSDC `0x0fd708f2260f6751526bc0d034282e223ade74bc7dde25c83f8fa4f6a2ae9155` | [HashScan](https://hashscan.io/testnet/transaction/0xf19c8eec304ac6ac619ed857d67bbca534ca1dc57e2599d172d5e48f30931678) | n/a |
| Demo cast order: Wren Errands buys `shell-navy-m` from Kestrel Outfitters (2 HBAR, agent `0.0.11345375` to shop `0.0.11345369`, 21:25 UTC; staged fault: ordered size S) | Hedera testnet | order `0xcd58af3bad0b332caf25d7716e553d4bb986daa4d7c2ab10a56505e4baf7f9a7` (topic messages 31 to 36) | `0.0.9185802@1794000214.443193179` | [HashScan](https://hashscan.io/testnet/transaction/1794000316.497874389) | n/a |
| Demo cast order: Wren Errands buys `shell-navy-l` from Kestrel Outfitters (2 HBAR, same accounts, 21:27 UTC) | Hedera testnet | order `0x7f5e15c97e2f47ee7666222b4fbc95fd38a11a2e2cae6dc96e46ac16a2c3c473` (topic messages 37 to 42) | `0.0.9185802@1794000412.591668177` | [HashScan](https://hashscan.io/testnet/transaction/1794000421.558073104) | n/a |
| Demo cast order: Wren Errands buys `tulips-white-10` from Fernhill Market (1.5 HBAR, agent `0.0.11345375` to shop `0.0.11345370`, 21:29 UTC; no claim) | Hedera testnet | order `0x4cf8b554e47d370ac2ff3bb01ba3107f955e8c901c36d78d88be055963842324` (topic messages 43 to 47) | `0.0.9185802@1794000565.892703674` | [HashScan](https://hashscan.io/testnet/transaction/1794000571.843270104) | n/a |
| Demo cast order: Lumen Metrics buys `forecast-100` from Quillon Data (1 HBAR, agent `0.0.11345381` to shop `0.0.11345372`, 21:30 UTC; no claim) | Hedera testnet | order `0xf175ae148fc9c930d3021d3bf320d45a15bb93475b0d539db6094e0dbbbc583b` (topic messages 48 to 52) | `0.0.9185802@1794000631.385411113` | [HashScan](https://hashscan.io/testnet/transaction/1794000638.443099104) | n/a |
| Demo cast order above a spend limit: Tallyhouse Procurement buys `jacket-navy-m` from Kestrel Outfitters for 3 HBAR, above its agent's 1 USDC spend limit, so the order waited for the buyer's approval (agent `0.0.11345379` to shop `0.0.11345369`, paid 21:35 UTC; no claim) | Hedera testnet | order `0x1b29c4ceecfaf964c9d0b2fea923188791150cbf6157e2a97495ebce2e382470` (topic messages 53 to 57) | `0.0.9185802@1794000940.643399346` | [HashScan](https://hashscan.io/testnet/transaction/1794000946.748318104) | n/a |
| Demo cast payout claim: filed, pre-checked 1 (agent company at fault), closed uncontested, 3.1 mUSDC paid from Wren Errands' deposit | Hedera testnet | claim `0xf5eee258fe2929efbb563d7464847f33ed5a28ffa13a80a500cc39666e2e8c69` | approve `0x4d8df03c2913e6b57a614c715a841f01ea60e6c8fe30fba096db2404c2799ae9`, fileClaim `0x45f3e866b271bccc0e332e935725eac2e0c1eeed32486ae23afb5c3fb7cb0687`, recordPreCheck `0x344a7717087812ffb41578278183ac4a32ec8852dba215db03906b9af0847b2a`, closeUncontested `0xea32791718bf40ff914a9a777d2b48dac9c91c1da6280675a3fea15dc23c026f` | [HashScan](https://hashscan.io/testnet/transaction/0xea32791718bf40ff914a9a777d2b48dac9c91c1da6280675a3fea15dc23c026f) | n/a |
| Demo cast claim: filed, pre-checked 3 (neither), closed uncontested, court fee refunded | Hedera testnet | claim `0x31002c8de2332a3723bbe75ecf45b3e46d10851fd351589e7c22d3832c62139c` | approve `0xac471c6e7cbc967095d4250649dce48e8a9bc07f4b61f5c1013d93cf1b0f49f3`, fileClaim `0x9ef3139ce815286ab8a53a76b523ce370039039ba80f824e1448ab6862f0032f`, recordPreCheck `0x3a25939a0a62e7dd3f73fcd70d7ccf374368ff2db99565e48eab1cfc9ee79a95`, closeUncontested `0x24adb42c4615179b4f4f6000927dc241902a9ebf22c6a099514406d718a10394` | [HashScan](https://hashscan.io/testnet/transaction/0x24adb42c4615179b4f4f6000927dc241902a9ebf22c6a099514406d718a10394) | n/a |
| Demo cast credit withdrawn (Kestrel Outfitters' 5.1 mUSDC: 4.1 from the payout claim and the other claim's refunded 1 mUSDC fee) | Hedera testnet | vault `0.0.11336129` | `0x5654ab4a3c35906cb034f04018dad9d8047a53e4177cead948bdd1e1004f5353` | [HashScan](https://hashscan.io/testnet/transaction/0x5654ab4a3c35906cb034f04018dad9d8047a53e4177cead948bdd1e1004f5353) | n/a |
| Arkiv writer wallet (the docket's scheme wallet) | Arkiv testnet (Rabdi, chain id 7794095) | `0x54E4545AFcf8960884A750320e70aFE16b2b3CaE` | n/a | [Arkiv explorer](https://rabdi.explorer.arkiv.network/address/0x54E4545AFcf8960884A750320e70aFE16b2b3CaE) | n/a |
| Arkiv `case` entity: dispute 212's ruled case (claim `0x392d6f13…7f3c50`), written 21:40 UTC | Arkiv testnet | entity `0x53b34e252b3f329dbe2df1a45cb686f191b98a011fe1a0166db839296491bd02` | n/a | [Arkiv explorer](https://rabdi.explorer.arkiv.network/entity/0x53b34e252b3f329dbe2df1a45cb686f191b98a011fe1a0166db839296491bd02) | n/a |
| Arkiv `monthly-count` entities, November 2026 | Arkiv testnet | `0x86b2af393fca1f63093dd3f2b5de6dcb724204d426bf8a8eb80bd0182380aa45` (Parcel Minds and Halden Supply), `0x377431fd4e09c89ec9819c51f5ec245195a05347ed078d672e868236d31abbba` (Wren Errands and Kestrel Outfitters) | n/a | [Arkiv explorer](https://rabdi.explorer.arkiv.network/entity/0x86b2af393fca1f63093dd3f2b5de6dcb724204d426bf8a8eb80bd0182380aa45) | n/a |
| Second claim taken to court: filed, pre-checked 1 (agent company at fault), contested by the agent company, sent | Hedera testnet | claim `0x00ad6c98af5cc7ae1e17dba7359c524ae8d6c37c32c1c01272830332e69efeae` | fileClaim `0xc7e81dcb98349b915f763fd8b1110d8d377865bd059da22442e38242b954c4e7`, recordPreCheck `0x4cd89a59e82aeb0ba4d3da18b91bc32774d065144bf4132d872e586e46022b0f`, contest `0xd8b02ce4c0f4a123f872f000aef0d7f3e56e34ef601528dc1d3cba293bcd6511` (Foundry's `cast send` from the platform's keystore), sendToCourt `0xf418e078580dffb4087a8d42e8513a59f5dfcdca088c64510c56f62707464b41` | [HashScan](https://hashscan.io/testnet/contract/0.0.11336130) | n/a |
| Second CCIP message to Arbitrum (`ClaimToCourt`) | Hedera to Arbitrum Sepolia | message `0x39a95b85a222c4c5c2a417c2fc070e8c710d1a8a25d64a752f75a497491fadca` | sent in `0xf418e078…464b41`, received in `0x23bda542d7cbea22c4449aad09a89115d9d145cae3e5fb0b501de1af557a02df` | [CCIP Explorer](https://ccip.chain.link/msg/0x39a95b85a222c4c5c2a417c2fc070e8c710d1a8a25d64a752f75a497491fadca) | n/a |
| Second Kleros case | Arbitrum Sepolia | dispute 213, court 8 | opened `0xbc5fe841b4b15b6e325e611d95b5ebdfe2e41f6ba8a6633738940617d51cb685`, evidence `0xcde24e5c0a10a21fb38eca3f42ae3945d743135ea431f4d50b4306677af947a9`, ruling executed `0x43e1f88268ed90b3048d762d80bd1628d5b59288285002976e0ab0e41ef65fef` | [Kleros](https://v2-testnet.kleros.builders/#/cases/213/overview) | n/a |
| Second CCIP message to Hedera (`RulingBack`) | Arbitrum Sepolia to Hedera | message `0x2c088d0e56c875a4d7fa8d605c50bf15e80f98179aed7a2d5d4725401bda2444` | sent in `0xb0529f9b700c14cd137116e3e0d9a01003f530abb77a28666e131884a0d03dcb`, received in `0xb6a5a8f7434155f0c522d58d0a4fc8f0de6d6798f679785c8a6b4fdf70cd6cce` | [CCIP Explorer](https://ccip.chain.link/msg/0x2c088d0e56c875a4d7fa8d605c50bf15e80f98179aed7a2d5d4725401bda2444) | n/a |
| Second court case settled | Hedera testnet | claim `0x00ad6c98af5cc7ae1e17dba7359c524ae8d6c37c32c1c01272830332e69efeae` | `0x46f9e3c8a9f35ced0776b924b2965b8dcc3c631275546f091c3afa944bd093ff`: ruling 1 applied, 3.575 mUSDC owed and paid from Parcel Minds' deposit (basket 1.50, handling 1.075, the shop's 1.00 court fee); the escrowed 1 mUSDC fee kept by the pool | [HashScan](https://hashscan.io/testnet/contract/0.0.11336130) | n/a |
| Second court case credit withdrawn | Hedera testnet | vault `0.0.11336129` | `0xa6bf86d82aa39310a96c1c2d9be3fc0480ef42fb61285756e8701d93d5afbacc`, 3.575 mUSDC to the shop `0x0d87ED2F5D792561B53043Ff028956125c820287` | [HashScan](https://hashscan.io/testnet/contract/0.0.11336129) | n/a |

### Test runs on testnet

`ops/e2e/run.sh` runs the checks against the deployed contracts, the status API, the web app and the services, and writes one `results.md` per run under `ops/e2e/results/`. A result is `pass`, `fail`, `blocked` (could not be tested) or `dry-only` (built and simulated, nothing sent). Four runs on the evening of 6 Nov, all on the same contracts (there was no redeploy):

| | run1 | run2 | run2b | run2c |
|---|---|---|---|---|
| Time (6 Nov, UTC) | 20:08-20:30 | 20:35-20:50 | 20:53-21:11 | 21:15-21:37 |
| Commit | `21ade87` | `801e5dd` | `74ac78a` | `58167d2` |
| Mode | dry (nothing sent), with every package test suite (`--suites`) | `--send --restarts --suites`: the dry checks, then a paid order and its claim on testnet, then service restarts and the suites | `--send --restarts --suites` | `--send --restarts --suites` |
| Pass | 296 | 242 | 285 | 276 |
| Fail | 1 | 1 | 1 | 1 |
| Blocked | 18 | 61 | 17 | 31 |
| Dry-only | 5 | 4 | 5 | 6 |
| What stopped it | Nothing: it ran to the end, and the 12 package test suites and `forge test` (301 passed, 3 skipped) passed. The fail is the keeper gas row, read before the restarted keeper had read its balances; since `0570d91` that case counts as blocked. | Order A (`0x042fcd28…f27f`) was paid and its records written, then its fileClaim got `upstream_unavailable` because the Hedera relay did not answer, so the run stopped there, before the restarts and the suites. That order was claimed later: it is the second claim taken to court. | Order A (`0xe1eeb65d…0c53`) was paid, its records written and its approve mined, then fileClaim needed 802,847 gas against its 800,000 budget, so the run stopped there, before the restarts and the suites. The budget is 1,000,000 since `5302756`. | Order A (`0xa876ad49…63d6`) was paid and its records written, then its fileClaim got `upstream_unavailable` because the Hedera relay did not answer, so the run stopped there, before the restarts and the suites. |
| Results | [run1](ops/e2e/results/run1/results.md) | [run2](ops/e2e/results/run2/results.md) | [run2b](ops/e2e/results/run2b/results.md) | [run2c](ops/e2e/results/run2c/results.md) |

Most blocked rows are the Hedera JSON-RPC relay not answering or answering too slowly (11 of 18 in run1, 57 of 61 in run2, 13 of 17 in run2b, 29 of 31 in run2c): a read was then served from the status API's last-good values while it reported the source degraded, which the run counts as blocked, or an action answered `upstream_unavailable`. The others had no claim in the state the check needs (for example none open to contest) or, in run1, no notifier log to read (`RECOURSE_NOTIFY_LOG` unset).

## Known limits

A code review of commit `f05649d` (6 Nov 2026, by four AI models, with every finding then checked against the code) confirmed 157 findings. Each has a review finding id, R01 to R157, and a severity: P0 loses or locks funds or forges a ruling, P1 gives a wrong outcome or breaks a flow, P2 is a robustness gap, P3 is minor. There was no P0. When the findings were checked against the code again at about 15:00 UTC that day, 112 P2 and P3 findings were still present or only partly fixed (38 P2, 74 P3).

The 10 P1 findings are not in the tables below. Five (R04, R07, R08, R09, R10) were already fixed in the source at that check, and four have had fixes committed since: R02 (`485316d`), R03 and R05 (`5e58081`) and R06 (`4109ef4`). R04 (`ece7d36`) is a contract change and the contracts have not been redeployed, so the deployed vault does not have it: a platform whose exit is due still reads as in good standing while every new claim against it reverts. R01 stays as an accepted limit, recorded in `docs/decisions.md` (`4b46366`): each court case has a cut-off on Arbitrum that falls before Hedera can expire its claim; a case that runs past it (for example on appeal) has its ruling dropped and its arbitration fee lost, and the shop gets back only its court fee. In the current source that cut-off is 2 h before Hedera's, which leaves time to relay a ruling (`f294d80`); the deployed `RecourseCase` predates it and, as the contracts have not been redeployed, does not have it.

Since that check, 33 of the 112 P2 and P3 findings have had fixes committed, each commit naming the finding or describing its fix (a reader can check each one): R13 (`873f6d3`, `fdf4b43`), R14 (`9fe5855`), R21 (`873f6d3`), R22 (`5e58081`), R26 (`bb5f16c`), R28 (`5a35970`), R29 (`5719e73`, `bc0175e`), R30 (`cb3b065`, `6e9f5c3`), R31 (`de695b3`), R32 (`46444f3`), R38 (`5e58081`, `e36767c`), R43 (`9fb4f9b`, `1068b29`), R47 (`108adcf`), R51 (`56fd0f6`), R53 (`109d794`), R56 (`5e58081`, `e36767c`), R57 (`873f6d3`), R58 (`5843978`), and later the same day R11 and R73 (`ec9739b`, follow-up `406a235`: the status API marks a failed live or parameter read as `degraded` and gives its age), R24, R25, R39 and R42 (`6f191f8`: the shop needs its party map to start, refuses complaints it cannot check, reads the payer from the payment, and checks the order again after the standing read), R27 (`3775bb1`: the approval renderer refuses a value it would not show as given) and R61 (`42eab83`, follow-up `11e5e7d`: a failure at verify counts toward the move to the backup facilitator), and in the evening seven status API findings: R20 and R54 (`eaa8b20`: the saved index records the deployment and records topic it was read from, and a restart during the first full read still answers "rebuilding"), R36 (`0896ecf`: right after a resend, the older message no longer marks a claim stuck), R18 (`ba0c77c`: a party's escrow is read from the vault, and a platform no longer counts its shops' court fees), R12 (`0ba62fe`, follow-up `f081f99`: court evidence is read in chunks, and a failed read shows in `/health`), R37 (`2527a58`: a missing document's retries back off up to 30 minutes, and document fetching has a time budget per poll) and R35 (`8db98c1`, follow-up `46f3fa0`: a ruling indexed after a failed case read no longer shows the case as open). R47 is a contract change and the contracts have not been redeployed, so the deployed vault does not have it. The tables leave those 33 out and list the other 79 (6 P2, 73 P3), grouped by part of the system, each with what can go wrong and the planned fix.

Terms used below: the *mirror node* is Hedera's public REST read API; a service's *journal* is its append-only state file, and its *cursors* record how far it has read each source; the *party map* (`deployments/parties.json`) names each party's accounts and which records each may write; the *read-back* (`ops/wire/00-readback.sh`) reads every deployed setting and compares it with the deployment files; the *lock* is each contract's one-way `lockConfig`; a *facilitator* is the x402 service that verifies and settles a payment.

<details>
<summary><strong>Contracts and their deploy scripts</strong> (7)</summary>

| Id | Sev. | Limit | Plan |
|---|---|---|---|
| R48 | P2 | If the pre-check signer is down for the claim timeout (18 h), a filed claim can be expired with its fee refunded, and that order can never be claimed again. | Let a claim that expired before its pre-check be filed again, or let only the shop expire it (needs a contract redeploy). |
| R69 | P3 | Partly fixed. `hedera.sh check` passes a deployment whose signer, relayer, pool or peer is a wrong but non-zero address, for example a claims contract still pointed at the retired case contract. | Compare the signer, relayer, pool and peer with the party map and the Arbitrum deployment file. |
| R70 | P3 | With a wrong RPC URL, the CCIP ping scripts can deploy or fund a ping on the wrong network and record it as the expected chain. | Check the RPC's chain id before a ping is deployed or funded. |
| R138 | P3 | A mistyped pool, signer or relayer address is deployed as given; the pool is fixed in the vault, so a typo there needs a redeploy (the read-back catches it only after the deploy). | Compare the three addresses with the party map before deploying. |
| R139 | P3 | If the locked `gasClaimToCourt` value in the deploy parameters is ever changed from the pre-lock value, the lock will not apply it and the check script will still expect the old one. | Have the lock apply the locked value and the check read it, or drop the unused value. |
| R140 | P3 | In circle mode (Circle's USDC instead of the mock) the preflight can pass with 12-22 HBAR and the deploy is then refused by forge's own balance check (the current deployment uses mock mode). | Use the mock path's HBAR floor in circle mode too, or raise the minimum to 30 HBAR. |
| R141 | P3 | If PING_OWNER is set at deploy, ping.json records the wrong owner for the ping contract. | Record the owner read back from the deployed ping contract. |

</details>

<details>
<summary><strong>Keeper (the service that moves a claim between the two chains)</strong> (4)</summary>

| Id | Sev. | Limit | Plan |
|---|---|---|---|
| R34 | P2 | If a Kleros nudge (a public call that moves a dispute along: passPeriod, executeRuling, draw, passPhase) goes pending and later fails, the keeper never retries it. An executeRuling stuck this way holds the claim until the operator steps in. | Keep a nudge open until its transaction succeeds, and retry it when it reverts or is dropped. |
| R49 | P2 | A call that is accepted, then mines reverted, is retried forever and never counts toward the failure limits that hold the claim and alert the operator. | Count a mined revert like any other failure, so the hold and the alert apply. |
| R87 | P3 | If the keeper crashes between reading a bridge-wide event (a rejected CCIP message or an appeal contribution) and handling it, that event's alert is never raised. | Journal a marker after each such event is handled, and raise any unhandled alert on replay. |
| R88 | P3 | While the parameter read fails, the keeper keeps using the last bridge mode it read. If the mode changed before the lock during such an outage, its relay calls revert and count as failures. | Forget the mode when the read fails, and send no relay call until it is read again. |

</details>

<details>
<summary><strong>Pre-check, intake and docket services</strong> (5)</summary>

| Id | Sev. | Limit | Plan |
|---|---|---|---|
| R65 | P3 | Random sampling (batch draws) is not built. In the design, only a random share of contested claims (p = 0.25, drawn with Hedera's PRNG) goes to court, the rest close undrawn with the court fee refunded, and the docket weights each sampled ruling by 1/p. In this version every contested claim goes to court (`RecourseClaims.batchOf` always returns 0), so the docket's undrawn-claim handling is unused code and every rate weight is 1. | Build `openBatch` and `drawBatch` on `RecourseClaims`, or remove the undrawn handling. No effect today. |
| R66 | P3 | Intake (the feedback tagger) answers 500 for a non-text order id, and records sent only by CID are not used unless an order id is given. | Answer 400 for a bad order id, and take the order id from a fetched document when none is given. |
| R99 | P3 | Arkiv entities expire 182 days after creation even if they were updated later, and extension is not built. | Correct `arkiv/schema.md`, or extend an entity's life when it is updated. |
| R100 | P3 | If two docket processes start at the same moment after a crash, both can run on one state directory. | Take over a stale lock through a separate exclusive file, so only one process wins. |
| R102 | P3 | Intake passes a user-supplied CID string unchecked into the gateway request and the intake pack, though the document's bytes are still verified against its hash. | Accept a reference only when its CID is the one its hash gives. |

</details>

<details>
<summary><strong>Shop and buying agent</strong> (8)</summary>

| Id | Sev. | Limit | Plan |
|---|---|---|---|
| R76 | P3 | An order in flight during a facilitator switch can fail at settle and must be paid again. | Settle on the same facilitator that verified the payment. |
| R103 | P3 | An order approved just before midnight UTC and paid after it counts toward the previous day's cap, not the new day's. | Count a payment toward the day it was signed, checked against the current day. |
| R104 | P3 | After one payment that is never confirmed, the agent gives up on the order (pay_failed) instead of paying again once that payment is dead. | Count payments actually signed rather than wait rounds, so waiting does not use up attempts. |
| R105 | P3 | When the shop refuses a payment the agent already signed, the order waits about 4 minutes before it is marked failed. | Check the payment once and end the order as soon as the signed transfer is dead. |
| R106 | P3 | If the mirror node is down while `pay-once` (a script that makes one small connectivity payment) waits on a signed payment, the script can pay the connectivity check a second time on the next facilitator. | Stop with "outcome unknown" and the transaction id instead of trying the next facilitator. |
| R107 | P3 | Re-running `pay-once` after a crash can pay the connectivity check twice. | Resolve the last signed payment in the journal before signing a new one. |
| R108 | P3 | `live-order --send` can pay for an order and write its records, then fail at filing because the shop cannot pay the court fee. | Check the shop's balance against the court fee before the order starts. |
| R109 | P3 | A rerun after the approval has expired can still post the asked, shown and approval records for an order that is then never paid. | Stop, writing nothing more, when the approval has expired and nothing was paid. |

</details>

<details>
<summary><strong>Shared packages (records, court evidence, canonical encoding)</strong> (13)</summary>

| Id | Sev. | Limit | Plan |
|---|---|---|---|
| R67 | P3 | Two commands started within a few microseconds of each other can both take the journal lock on one host. | Treat an empty or invalid process id in the lock as "not written yet" and retry. |
| R77 | P3 | Handling amounts use testnet demo values (1 USDC base, 4 USDC cap) instead of the design's 15 and 40; they are recorded only in the interfaces spec changelog. | Add a row for them to `docs/decisions.md`. |
| R78 | P3 | The local test relay can deliver a CCIP message whose sending transaction reverted at a higher level (local runs only). | Stop the local relay from delivering a message whose sending call failed. |
| R110 | P3 | A claim message the Arbitrum case rejected shows as 'At court' until the claim times out, hiding that no court case will open. | Show such a claim as stuck, with "expire the claim" once it can be expired. |
| R111 | P3 | On another host or user, the default suite lock path (`SUITE_LOCK_FILE`) points at the operator's home folder, and local deploys fail with a missing-directory error. | Build the default from the current user's home and create its folder. |
| R112 | P3 | A caller passing a sparse array would hash and pin bytes that are not JSON and that the parser rejects. | Refuse sparse arrays in the canonical encoder. |
| R113 | P3 | Without a readable party map, a service starts writing records without checking that its account is an allowed writer, so readers may ignore every record it writes. | Warn when the writer check cannot run, and fail when the named party map is missing. |
| R114 | P3 | If a party ever uses two writer accounts, a writer can commit a record whose slot readers already fill with the other account's message. | Check conflicts against the party's whole writer set from the party map. |
| R115 | P3 | A lagging or failing mirror can cause a duplicate record message with the same document; readers still use the first. | Keep polling on a mirror error, and treat only a definite miss as "never landed". |
| R117 | P3 | A party's own writer can post a zero-hash record message and then replace it with a later one, breaking first-message-wins for that slot. | Reject an all-zero hash when a record message is decoded. |
| R118 | P3 | Gateway timeouts and network errors reach callers as raw JavaScript errors, not as the module's own "fetch failed" error. | Wrap them in the module's own error. |
| R119 | P3 | `pin --verify` exits 0 even when a gateway does not serve the pinned document or serves different bytes; read the output line. | Exit non-zero when any gateway check fails. |
| R121 | P3 | A registration URL from the open ERC-8004 registry can make the service download a large body (up to the 15 s timeout) before the 64 KiB limit applies. | Refuse a large declared size up front and stop reading past 64 KiB. |

</details>

<details>
<summary><strong>Status API (the read API behind the web app)</strong> (11)</summary>

| Id | Sev. | Limit | Plan |
|---|---|---|---|
| R19 | P2 | An Arbitrum reorg deeper than 20 blocks would leave events from the dropped blocks in the index for good. | Keep recent block hashes, detect a fork, and drop the events of dropped blocks. |
| R74 | P3 | For a few seconds (about 20 Arbitrum blocks) the bridge can show a message as delivered while the case still reads as not received. | Read the message state at the same confirmed block as the other Arbitrum reads. |
| R75 | P3 | On a fresh local chain with fewer than 20 blocks, every Arbitrum contract read fails. | Clamp the confirmed block number at zero. |
| R89 | P3 | With no Hedera RPC set, deadlines and amounts come from built-in pre-lock defaults and only the /params page says so. | Flag the parameters whenever they come from the built-in defaults. |
| R90 | P3 | While a ruling is on its way back to Hedera, the court shows as ruled but the ruling and the amount owed stay blank. | Show the Arbitrum ruling in its own field until Hedera records it. |
| R91 | P3 | A finished claim whose Arbitrum case is later marked stale keeps showing the case's earlier state. | Re-read a finished claim's case at a slow pace until the case can no longer change. |
| R92 | P3 | A finished claim with an old failed send keeps getting re-read every poll, which costs RPC calls but changes nothing shown. | Treat a finished claim as done once a message in each direction has succeeded. |
| R94 | P3 | After a long Arbitrum outage, catching up runs as one long poll that delays the other sources, and a restart midway starts the catch-up over. | Cap the catch-up per poll and keep the cursor at the last block range read. |
| R95 | P3 | If the mirror's blocks endpoint is down, a lagging mirror can look up to date. | Leave the mirror's position unchanged when its head cannot be read. |
| R97 | P3 | While a shop has any credit to withdraw, every finished claim shows as waiting on it, even ones that paid nothing. | Show a claim as waiting on a withdrawal only if it credited the shop. |
| R98 | P3 | A bridge message the other chain rejected or ignored does not appear on its claim's timeline. | Map rejected and ignored messages to their claim and show them on its timeline. |

</details>

<details>
<summary><strong>Web app</strong> (16)</summary>

| Id | Sev. | Limit | Plan |
|---|---|---|---|
| R64 | P2 | There is no approval page: the buyer approves with the agent CLI and cannot check the rendered offer and its hash in the browser. | Add an approval page that re-renders the offer and checks its hash in the browser. |
| R71 | P3 | If the status API is down or rebuilding, a search for a real claim says nothing matches. | Say the search could not run, instead of showing no matches. |
| R85 | P3 | A status the web bundle does not know (API newer than the page) or a malformed reply blanks the whole site. | Show an unknown status by its raw name, and catch page errors in an error card. |
| R142 | P3 | When the vault cannot be read, the party page says no top-up is due instead of saying it is unknown. | Say "not read" when the vault could not be read. |
| R143 | P3 | An unresolved claim still waiting for settle shows its money step as 'did not happen'. | Treat the status as final only when no next call is due. |
| R144 | P3 | Between sending a claim to court and the court case opening, the court card says 'Not at court.' | Say "sent to court; the court case is not opened yet". |
| R145 | P3 | A docket entry that has given up publishing still reads 'it will be retried'. | Pass the docket's retry state through and say when it will not retry. |
| R146 | P3 | A record found by order id is flagged 'not the one the shop referenced' even when the shop referenced no record of that kind. | Warn only when the shop referenced a record of that kind. |
| R147 | P3 | The docket page can show 'not published yet' where the docket service itself shows a sample rate, because it ignores sample mode and z. | Read the docket's sample mode and z from its settings. |
| R148 | P3 | The docket page reads Arkiv once when it opens; it does not refresh or retry, though it says it read 'just now'. | Re-read on an interval and show the read time. |
| R151 | P3 | After editing the order id, the File page keeps showing the previous order's records, finding and filing form until Load is pressed again. | Clear the loaded order when its id changes, and drop replies for an old id. |
| R153 | P3 | A web build with an empty or non-numeric `VITE_POLL_MS` polls the API back to back from every open tab. | Fall back to a 5 s interval unless the value is a number of at least 1 s. |
| R154 | P3 | An Arkiv endpoint that keeps returning full pages makes the docket page read without end. | Cap the pages read and stop when a page repeats. |
| R155 | P3 | Run before a build, the web secret check (which looks for secret names in the built bundle) reports clean without scanning anything. | Fail, or say the bundle was not scanned, when there is no build. |
| R156 | P3 | The source `index.html` is checked only for five fixed names, not the secret-name patterns. | Apply the same name and pattern checks to `index.html`. |
| R157 | P3 | Env names with a suffix after KEY or SECRET (e.g. *_KEY_ID, *_SECRET_TOKEN) pass the web secret check. | Widen the pattern to names with a suffix after KEY or SECRET. |

</details>

<details>
<summary><strong>Operations scripts (funding, wiring, checks, secret scan)</strong> (15)</summary>

| Id | Sev. | Limit | Plan |
|---|---|---|---|
| R15 | P2 | Partly fixed. Until the next read-back with `--record`, `deployments/wiring.json` still names the retired claims contract as the case contract's peer (with a note); the chain itself is correct. | Run the read-back with `--record` once; the redeploy rewrites the file anyway. |
| R80 | P3 | `02-fund-hedera-roles.sh --send` stops with a cast error if the buyer or the facilitator has no Hedera account yet. | Skip a role with no account, with a note, instead of sending. |
| R81 | P3 | Each re-run of `03-fund-arbitrum.sh --send` moves another 0.035 ETH from the deployer to ops-arb. | Send only the shortfall up to the target balance. |
| R83 | P3 | While a wiring, funding or check script runs, any local user can read a keyed RPC URL from the process list. | Pass the RPC URL in the environment instead of on the command line. |
| R123 | P3 | A private key pasted as a bare 64-hex string, with no key/secret/seed word on its line, passes the secret scan. | Add a scan rule for any 64-hex value assigned to a name outside the deployment and docs files. |
| R124 | P3 | A keyed thirdweb, tenderly, pocket or drpc RPC URL committed to the repo is not caught by the secret scan. | Add those providers' keyed URL forms and a general rule for key or token query values. |
| R126 | P3 | With the default file permissions (umask 022), the copy of the env file (keyed URLs, key paths) is world-readable for a moment, and stays that way if the script is interrupted. | Create the copy with private permissions before writing to it. |
| R127 | P3 | If the agent's Hedera account is missing, `--write` saves the party map with no platform writer, and the platform's records are then ignored. | Refuse to write the party map when the agent or the shop has no account, unless asked to. |
| R130 | P3 | A deploy with a wrong CCIP chain selector, router or arbitrator passes every read-back and can be locked. | Compare the selectors, routers and arbitrator with the known testnet values in the read-back. |
| R131 | P3 | If the lock's receipt times out after broadcast, the lock transaction is never written to `wiring.json`, and re-running the step refuses. | Take the hash before waiting for the receipt, and recover a missing lock hash from its event. |
| R132 | P3 | A deployments file from another chain passes if a contract happens to sit at the same address on the checked chain. | Check the file's chain id against the chain being checked. |
| R133 | P3 | Two wiring steps run at the same time can lose one step's row in wiring.json. | Take a file lock around each update of `wiring.json`. |
| R134 | P3 | Partly fixed. Wiring step 06 can write a claims-contract gas limit below the measured Arbitrum receive cost; the next read-back catches it, and it can be reset because `setExtraArgs` stays callable. | Refuse a gas limit below the measured receive cost before sending. |
| R135 | P3 | A required-deposit amount typed above the platform's deposit is written and then fails the standing check; `setRequired` stays callable to correct it. | Refuse an amount above the platform's deposit before sending. |
| R136 | P3 | The wiring rehearsal uses ports 8610-8619, not the range the port plan gave it, so it could collide with other local runs. | Move it to its planned range (18730-18734) if that plan holds. |

</details>

### Disputed findings

Four findings were checked and are disputed: the code does not do what the finding says, or the behaviour is intended and documented.

| Id | Finding | Why it is disputed |
|---|---|---|
| R86 | `RecourseClaims` takes and holds HBAR to pay CCIP fees when LINK is short (against an early planning note that said LINK only); after the lock that HBAR can leave only as CCIP fees. | Intended and documented: `docs/decisions.md` ("CCIP fees") and the owner-powers tables above describe the HBAR path. |
| R120 | The Kleros template check could throw on a template missing its arbitrator address or answers, instead of returning a failure. | Cannot happen: the pinned Kleros SDK (2.4.0) validates the template and throws, and `packages/court/src/validate.ts` catches that and returns a failure. |
| R129 | The read-back unlocks five role keystores on one host to derive their addresses. | Accepted under the decision to run everything, keys included, on one host (`docs/decisions.md`, "Where code runs"); reading the keystores also catches a wrong key file. |
| R137 | The intake and docket services listen on all network interfaces. | They do not: both bind 127.0.0.1 (`services/intake/src/main.ts`, `services/docket/src/boot.ts`); only a line in `ops/units/README.md` was stale, and it has been corrected. |

## Disclosures

- Record documents: the hashes are public; anyone can check a document against them. Each record's CID and SHA-256 are on the public HCS topic, but the documents are not on public IPFS: Filebase pinning (`IPFS_PIN_API_KEY`, `IPFS_PIN_API_SECRET`, `IPFS_PIN_BUCKET`) is not configured, so every service pins to a content store on the demo host instead (`IPFS_PIN_API_URL=file://…`, one file per CID in `~/.local/state/recourse/ipfs`, `packages/records/src/ipfs.ts`). The CIDs are the ones a public pin of the same bytes would get. For a claim taken to court, the keeper posts as Kleros evidence on Arbitrum Sepolia every record document the pre-check used, byte for byte with its SHA-256, and the pre-check's result document (`packages/court/src/evidence.ts`). That evidence is public and permanent, so anyone can read those documents and check them against the hashes on HCS without the demo host; dispute 212's evidence is transaction `0x6c97c6c8…4f9959` and dispute 213's is `0xcde24e5c…f947a9`, both in the table above. For a claim not taken to court, the documents can be read off the host only through the status API (`GET /orders/<orderId>/records` returns each record's document after checking it against its hash), which the web app shows, and only while the host is up. Buyer fields inside them are salted; anyone who can read a document can read the rest of it, which for a claim taken to court means anyone.
- The shop attests its own net loss when it files (capped at the basket value); the pre-check signer is a trusted step; the docket is de-identified, and the scheme wallet that writes it also receives any unrefunded escrow.
- A platform with no deposit can still be claimed against; the shortfall is shown, not hidden.
- The court is Kleros testnet court 8, a test court with test jurors.
- Most of this code was written by Claude agents directed by the team. See [docs/ai-use.md](docs/ai-use.md) for what was generated, by which model, and what people decided and reviewed.
- Licence: MIT ([LICENSE](LICENSE)).
