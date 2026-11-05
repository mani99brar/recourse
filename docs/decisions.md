# Decisions

Build defaults taken on 5 Nov 2026. The operator can change any row; open questions are at the end.

## Build setup

| Topic | Decision |
|---|---|
| Where code runs | Everything (code, tests, deploys, services) runs on one Linux host. The deployer key lives there too. |
| Keys | One Foundry v3 keystore per role in `$KEYSTORE_DIR` (outside the repo, 0700), password in `<file>.pass` (0600). Roles: deployer, ops-hedera, ops-arb, precheck-signer, platform, agent, shop, scheme, buyer, facilitator. Never in argv, logs or git. |
| Secret scan | `ops/scan/scan.sh` runs as a pre-push hook. |
| Commits | `ops/scripts/commit.sh` stages named paths only, so parallel work in one tree never mixes. |
| Repo visibility | Private until the operator makes it public. |
| Node | v24. |
| x402 | `@x402/*` 2.28.0 with `@hiero-ledger/sdk` 2.85.0. |
| Hedera upgrade window | Hedera testnet upgrades on Fri 6 Nov, 18:00-18:40 UTC. No Hedera sends, CCIP messages or demo claims in that window; re-read status.hedera.com before it. |
| Keeper reads | Arbitrum reads at `latest`, not `finalized`: free endpoints lag about 17 min and fail deep historical reads. |
| CCIP fees | LINK when the ops addresses hold it; otherwise native gas (HBAR fees use 8-decimal amounts on Hedera). |

## Product rules

| Topic | Decision |
|---|---|
| Records | Six slots in order: asked (I), shown (S), approval (A), ordered (O), packed (D), arrived (R). Approval is its own record. |
| Fault rule | A 12-step check over I-S, the change slot and approval, then S-O, O-D and O-R. A break ranks above an absence. Missing on both sides gives "not enough record". |
| Below-limit buys | With no human approval below the spend limit, the approval record holds the agent's mandate approval and counts as approved. |
| Gap 255 | 255 with answer 0 = not enough record. 255 with answer 1 or 2 = a missing record, against that side. |
| Record hash | SHA-256 over the exact pinned bytes. Buyer fields are salted. |
| `orderId`, `claimId` | `keccak256(abi.encode("recourse.order.v1", platform, shop, orderNonce))`. `claimId = keccak256(abi.encode(296, claims, orderId))`. One claim per order. |
| `packHash` | SHA-256 of the pinned `precheck-result` document. |
| Court fee | 3 USDC, read from a parameter. |
| Exit | `requestExit` plus `exitDelay`. |
| Stuck claims | `claimTimeout` is 18 h. On Hedera, `expireClaim` works on a Filed claim after `claimTimeout` from `filedAt`, and on a Contested or AtCourt claim after `claimTimeout` from `preCheckedAt`. A PreChecked claim never expires: it closes uncontested once its contest window ends. A later ruling is ignored, with an event. |
| Stale cases | On Arbitrum, anyone can call `markStale` once `filedAt + claimTimeout` has passed; it frees the open-case slot. Arbitrum counts from `filedAt` and Hedera from `preCheckedAt`, so a ruling that lands in the few minutes between the two is ignored on Arbitrum, and the claim then expires on Hedera with the court fee refunded. Accepted. |
| Exit and new claims | Once a requested exit is due, `escrowFee` and `fileClaim` revert with `ExitDue()`. |
| Payout | `netLossUsdc ≤ basketUsdc`, checked at filing. The shop attests alone (disclosed). |
| CCIP finality | Full finality, plain receivers. |
| USDC association | Explicit, after deploy, checked on the mirror node. |
| Facilitator | x402.org first, then Blocky402, then self-hosted. |
| Privacy | Record docs are public by CID (disclosed). Buyer fields are salted. The docket is de-identified. |
| Contest | The losing side contests, within a 30-minute window. |
| Good standing | The shop checks `inGoodStanding` before it accepts an order. |
| Top-up | Derived on every read, with a `topUpDeadline` view and a `TopUpCleared` event. |
| Unknown platform | Claims against a platform with no deposit are allowed. The `Shortfall` is shown. |
| Ruling 0 twice | Treated as a ruling equal to the pre-check answer, fee included. |
| Batch draw | Not built unless the contract suite is green early. Every weight is 1. |
| Rates | Wilson 95% interval on weighted counts. Uncontested closures are counted beside the rates, not in them. |
| Arkiv | Maximum entity lifetime. A local store sits behind the same write-status endpoint until an access key exists. |
| Open-case cap | `maxOpenCases` is checked in `openCase`. Resend is permissionless. |
| Mixed fault | The platform pays. |
| Pre-filing check | The web page runs the shared rule in the browser. |
| Shop registry | None. Known parties come from `deployments/parties.json`. |
| Evidence format | `packages/court` owns it. The keeper posts it. |
| Appeals | The keeper never appeals. It alerts on contributions. |
| Test cases | DisputeResolver test cases run from the host that holds the ops-arb key. |
| Display names | Fictional shop and agent-company names, chosen once and kept in `deployments/parties.json`. |

## Waiting on the operator

- Testnet HBAR, Arbitrum Sepolia ETH and LINK. Every faucet needs a human check.
- Circle testnet USDC, after the accounts are associated.
- An Arkiv Hub access key. Until then, the docket writes to the local store.
- An LLM key for the intake classifier. Until then, intake runs the shared rule only.
- A public HTTPS URL for the shop and status API (tunnel by default).
