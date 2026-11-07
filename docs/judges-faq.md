# Recourse: questions judges ask

## How to read this

Recourse lets a shop get its money back when an AI shopping agent buys the wrong thing. The agent belongs to an **agent
company** (the code calls it the "platform"); the **shop** is the seller. For each order both write short **records** to a
public log; a shop that receives the wrong goods files a **claim**; a fixed rule names the side at fault; and when that is
the agent company, money it locked in a contract beforehand (its **deposit**) pays the shop. It all runs on test networks
(testnets) with test money. Evidence follows each answer (repository paths; line numbers at commit `a48e219` unless another is named). Questions the sources cannot answer are under Open.

## The problem

### What problem does Recourse solve, and who pays for a wrong order today?

AI agents can now pay shops by themselves. The agents here pay with **x402**, a way to pay over plain HTTP: the shop answers
"402 Payment Required" with a price, the agent signs a transfer on Hedera (a public ledger network) and asks again, and the
shop settles it before replying. Nothing in that flow reverses a payment, so the project's premise is that the shop carries
the loss of a wrong order, because nobody can show whose mistake it was.

Evidence: `services/status-api/API.md:126-133` (the x402 order flow); README.md, first paragraph. How often it happens is under Open.

### A wrong T-shirt costs $15. Why not just refund it?

Most claims are meant to end without a court. A fixed rule compares the order's records and names the side at fault; if
that side does not object within a short window (10 minutes on the live contracts, 30 once their settings are locked), the
claim closes by that finding and the money moves by rule. Only a contested claim goes to court, and the loser there pays a
court fee, which discourages weak contests. We have not worked out the basket value at which a court case pays for itself.

Evidence: `contracts/src/hedera/RecourseClaims.sol:190-203` (`closeUncontested`); `packages/shared/vectors/params.json` (`contestWindow` 600 s before the lock, 1,800 s after); the settle table in `docs/spec/interfaces.md` §10.

## How it works

### What is recorded for each order, and by whom?

Six records, each one message on a **Hedera Consensus Service (HCS)** topic, a public log in which Hedera fixes the order and
time of every message; the message holds the document's content id and SHA-256 hash. Before paying, the agent records what
the buyer asked for, what it showed the buyer and the approval; after paying, what it ordered, with the payment id. The shop
records what it packed, and the buyer signs what arrived. A record counts only from the known writer for its kind.

Evidence: `services/agent/src/buy.ts:446-465` (the three records "written before paying") and `:490-500` (the ordered record, with `x402TxId`); `docs/spec/interfaces.md` §2; HCS topic `0.0.11335218`.

### What are the pre-check and the fault rule?

The **fault rule** is a fixed table: 12 steps, with step 2 split four ways (15 rows). It compares brand, size, colour,
quantity, price and merchant across the records and returns the first gap and an answer: 1 the agent company is at fault,
2 the shop, 3 neither, 0 not enough record. A missing record counts against its writer. The **pre-check** is a service that
runs the rule on the records, stores the result document and signs the finding onto the claim. No AI model takes part.

Evidence: `packages/shared/src/faultRule.ts:58` (`RULE_STEPS`), `:193-205` (answers), `:213-302` (the table); `docs/spec/interfaces.md` §9; `packages/shared/test/faultRule.test.ts` runs the 47 rows of `packages/shared/vectors/fault-rule.json`, written by a second agent from the rule text alone (`docs/ai-use.md:41`); README ("No model decides money at any point at runtime").

### What happens after the pre-check?

The finding opens a **contest window**: 600 s now, 1,800 s after the **config lock** (a one-way switch, `lockConfig`, that
freezes the contracts' settings). Only the side the finding goes against may contest: the agent company on answer 1, else
the shop. Uncontested, anyone can then close the claim. Contested, it goes by **Chainlink CCIP** (a cross-chain messaging
network) to Arbitrum (an Ethereum layer-2), into a **Kleros court**, where jurors who stake PNK tokens are drawn to rule.

Evidence: `RecourseClaims.sol:173-184` (`contest`; who may contest at `:178`), `:190-203`, `:207-218` (`sendToCourt`); `contracts/src/arbitrum/RecourseCase.sol:222-235` (`openCase`), `:297-324` (`rule`); `docs/checks.md:86` (court 8, minimum stake 11,000 PNK).

### Who pays what when a claim ends?

On filing, the contract holds a 1 mUSDC court fee from the shop (mUSDC is the demo's mock USDC; see What is live). If the
agent company is at fault and nobody contests, its deposit pays the shop's net loss, as the shop states it, plus handling of
min(1 + 5% of the basket, 4) mUSDC, and the fee is refunded. After a ruling the loser bears the fee. If the shop is at fault,
or nobody is, it gets nothing; if it contested and lost, its fee goes to the pool, a Recourse wallet that takes unrefunded fees.

Evidence: README "One claim, end to end", step 6 ("the loser pays the court fee"); `docs/spec/interfaces.md` §10 (settle table, every case) and §12 (parameters); `contracts/src/hedera/SettleMath.sol`; `packages/shared/vectors/settle.json`; `deployments/hedera.json` (`roles.pool`); README Disclosures.

### Why put this on chain, and why these chains?

The aim is that neither side can rewrite the records or hold back the money, and that a finding or ruling moves money by
fixed rules (until the config lock the team still can; see below). Hedera holds the payments, records, claims and deposits,
because the agents pay over x402 there. The Kleros court runs on Arbitrum, so CCIP carries each contested claim there and
each ruling back, from inside both contracts. A malformed message is ignored with an event, never reverted, so it cannot block the route.

Evidence: README "Architecture" and "How each technology is used"; CCIP send and receive at `RecourseClaims.sol:207-235`, `:296` and `RecourseCase.sol:164`, `:335`; messages `0x6631dc70a8a954c4e442cb8104af8d5c45b2117724d6deea096e9a8d6bc60adc` (to Arbitrum) and `0xbc0bb5f319c9045d70576b7a906c84b149a10c6de6638eda8eb4148e29d52ff3` (back to Hedera).

## Trust and cheating

### The agent company's agent writes five of the six records. What stops it cheating?

Three records are public before any money moves, and nothing written after the claim is filed counts. Above the spend
limit the buyer signs the approval over a hash of the text shown, and the buyer signs what arrived. HCS proves who wrote
what and when, not that it is true; a false record is evidence against its writer in court. The deposit cannot be pulled
to dodge a claim: leaving takes notice (10 minutes now, 120 days after the lock), with no claim open, and shops then refuse its orders.

Evidence: `services/precheck/src/proof.ts:1-6`, `:173`, `:237` (records after the filing never count); `services/agent/scripts/approve.ts:1-3` and `services/agent/src/approval.ts` (the buyer's EIP-712 signature); `contracts/src/hedera/DepositVault.sol:188-204` (`requestExit`, `exit`, `OpenClaims`); `params.json` (`exitDelay` 600 s, 10,368,000 s after the lock); `services/shop/src/app.ts:398-402`.

### Below the spend limit the agent approves changes itself. Does that not defeat the point?

It weakens it, and it is an open design question. Below the limit (5 USDC by default) no person is asked: the agent signs
the approval itself, citing a mandate document its company pins with its limits (the buyer does not sign it in this build),
and the rule treats that as a buyer's approval. Both live claims ended "neither" this way: asked M, shown L with the change
flagged, approved by mandate, L arrived. Whether this should clear a size or colour change is being decided; the rule is unchanged.

Evidence: `packages/shared/src/faultRule.ts:37-41`, `:179` (only `approval` is read), `:375-381`; `docs/spec/interfaces.md:113` (`approvalBasis` "Ignored by the rule"); `docs/decisions.md:26`; `services/agent/src/limits.ts:17-22`, `:50-54`; `services/agent/src/buy.ts:416-428` (the mandate approval) and `services/agent/src/docs.ts:118-128` (the mandate document); row 105 of `fault-rule.json`; topic `0.0.11335218`, messages 1-6 and 7-12 (the two orders' records).

### What stops the shop cheating?

It can file only for its own orders (the claim id comes from the caller's address), once per order. It writes only the
packed record, and the buyer signs what arrived, so a packed-versus-arrived gap counts against it. It states its own net
loss, capped at the basket price (disclosed). A claim from an unknown shop address gets no pre-check and expires. A review
found the agent took the shop's word for the payment id; it now checks it against its own payment and Hedera's records.

Evidence: `RecourseClaims.sol:112-132` (`fileClaim`: order id from the caller at `:129`, net loss at most the basket at `:125`, one claim per order at `:132`); `faultRule.ts:279-283` (step 5); `services/precheck/src/service.ts:10-15`; `docs/decisions.md:54`; README Disclosures; `services/agent/src/buy.ts:697-705` at `a48e219` (the shop's payment id taken as is), fixed in commit `4109ef4` (`payment_mismatch`; header of `services/agent/src/buy.ts`).

### Who checks the pre-check, and can I re-run it myself?

The pre-check signer is the one trusted step: the contract checks only that the finding comes from its key, kept on the
demo host. Two things limit it: the finding stores the SHA-256 of its result document, and the losing side can contest it
to the court. You can check any record document against its public hash, but not yet re-run the rule from an independent
copy: the documents sit on the demo host, served by its API, not on IPFS (a public content-addressed file network).

Evidence: `RecourseClaims.sol:155-169` (sender check at `:156`); `docs/keys.md:15`, `:24`; `packages/records/src/ipfs.ts:1-11`; `GET /v1/orders/{orderId}/records`, field `doc` (schema `RecordInfo` in `services/status-api/openapi.json`); README Disclosures; `docs/decisions.md:66`.

### Can the Recourse team decide a claim today?

Yes. Until the config lock, the deployer key (the team key that owns the contracts) can make itself the pre-check signer,
switch to a mode in which it records rulings itself, or point the bridge at a contract it controls, and so decide any open
claim. No contract is locked, and that key sits on the same host as the services reached through public tunnels. The lock
removes every power that decides a claim; it waits on a redeploy of the court contract, and no date is set.

Evidence: README "Owner powers and spend paths" (what the owner keeps after the lock); `RecourseClaims.sol:362-395`; `deployments/wiring.json` (`lock` is empty); `docs/decisions.md:9`, `:34`; `docs/keys.md:15`.

### What can the keeper get wrong, and what if it stops?

The **keeper** is the team's service that moves claims along: it closes uncontested claims, sends contested ones over CCIP,
opens the Kleros case and pays its fee, posts evidence, relays the ruling and settles. Each call is open to anyone and the
`/v1` API builds them for any caller, so a stopped keeper delays a claim but cannot decide it; a long delay can make it
expire, fee refunded. In the default mode, where rulings arrive only by CCIP, its key cannot record a ruling.

Evidence: README "One claim, end to end" ("anyone may call"); `services/status-api/API.md:71-86`; `RecourseClaims.sol:261-263` (`recordRuling` refused in the default mode); `deployments/hedera.json` (`mode` 0, the default; `contracts/src/shared/RecourseTypes.sol:38-41`); `docs/keys.md:22`; `docs/runbook.md:62` (a restart after a memory kill on 6 Nov).

## Cost and speed

### How long does a claim take?

Uncontested: in the first court case the finding landed 21 seconds after filing, and a claim can close once its window
ends, so about 10 minutes today and 30 after the lock. Contested, that case took about 2 hours 5 minutes from filing
(09:05:57 UTC, 6 Nov) to settlement (11:10:52): CCIP out under a minute, Kleros 1 hour 43 minutes to an executed ruling,
CCIP back 18 minutes. Court 8's full periods total 2 hours 15 minutes; this vote came in early.

Evidence: README "Deployed addresses and transactions", claim `0x392d6f13cdf5fe1ca93289d143e51b511f333de3d6d1769c72ddd0039c7f3c50`: filed `0xb0486c1e1cec26ef8910dceb092888e00ad2f798590531f36fe56ceb99679776`, pre-checked `0x22454f7e9df75d5052a39a8c7cfa0a74c3696ebaf9f6e75d6adcd40621990810`, case opened `0x993c49af2b77ed0710c5e3f5d17efc9789e80333a488ca3f894058ae6eb83a42`, ruling executed `0xeebfe2fea6267ecc3acbdc30a6ab74981ed653b4efba12c0abae86f06e41d417`, settled `0x502db49f52f56bb2e1f014277139ccf140344186e6a5f257a9c59d7b9d90bd40`; `docs/checks.md:83` (periods 900, 2,700, 1,800 and 2,700 s). The second court case, claim `0x00ad6c98af5cc7ae1e17dba7359c524ae8d6c37c32c1c01272830332e69efeae` (Kleros dispute 213, the agent company at fault and contesting), took 1 hour 41 minutes from filing (21:43:12 UTC) to settlement (23:23:55): pre-check 2 minutes after filing, contest 5 minutes later, CCIP out in 36 seconds, Kleros 1 hour 9 minutes from opening to an executed ruling, CCIP back 19 minutes. Its steps: filed `0xc7e81dcb98349b915f763fd8b1110d8d377865bd059da22442e38242b954c4e7`, pre-checked `0x4cd89a59e82aeb0ba4d3da18b91bc32774d065144bf4132d872e586e46022b0f`, contested `0xd8b02ce4c0f4a123f872f000aef0d7f3e56e34ef601528dc1d3cba293bcd6511`, case opened `0xbc5fe841b4b15b6e325e611d95b5ebdfe2e41f6ba8a6633738940617d51cb685`, ruling executed `0x43e1f88268ed90b3048d762d80bd1628d5b59288285002976e0ab0e41ef65fef`, settled `0x46f9e3c8a9f35ced0776b924b2965b8dcc3c631275546f091c3afa944bd093ff`.

### What does a claim cost?

On the demo the shop escrows a 1 mUSDC court fee, refunded unless it loses in court; a payout adds the handling amount.
Opening the Kleros case cost 0.00081 ETH, paid from the court contract's fee pool (ETH the team puts in). Relaying the
ruling back cost at most 0.0000687 ETH in CCIP fees (68,747,589,650,264 wei attached; any surplus is returned). The court
fee and the Kleros cost are not linked yet; sizing the fee to cover real court costs is open work.

Evidence: `params.json` (`courtFeeUsdc` 1,000,000 micro-units); `docs/checks.md:82`, `:117`; README "What is live", Funding row (fee pool 0.01 ETH, 0.00919 ETH after dispute 212); README "Owner powers" (`relayRuling` returns the surplus); relay transaction `0x6d471236aac5149728e96e977fc492ff2b5536fefeb8c545bf121e29a8f13c0d` (value attached). Gas and HCS fees per claim are under Open.

## Failures

### What if a CCIP message is slow or fails?

Anyone can send the same message again, at most 5 times per claim and 30 minutes apart; the first copy to land wins. The
keeper alerts after 10 minutes outbound or 45 on the return, and resends a message still untouched an hour after the last
send. A message that fails on delivery can be run by hand from the CCIP Explorer by any funded account. If nothing lands,
anyone can expire the claim 18 hours after its pre-check: the court fee is refunded and nothing is paid out.

Evidence: `RecourseClaims.sol:220-235` (`resend`), `:237-257` (`expireClaim`); `RecourseCase.sol:335-344` (`relayRuling` limits); `params.json` (`maxSends` 5, `resendGap` 1,800 s, `claimTimeout` 64,800 s); `docs/runbook.md:68`; `services/keeper/RUNBOOK.md:5-37`.

### What if Kleros is slow, refuses to rule, or the case is appealed?

A refusal (ruling 0) is refiled once; a second counts as the pre-check's answer. Each case has a cut-off: a case that can no
longer finish a court round is not opened, a ruling at or after the cut-off is ignored, and the claim then expires with the
fee refunded. The keeper never appeals; an appeal past the cut-off loses the arbitration fee paid (accepted). The deployed
court contract's cut-off still equals Hedera's 18-hour timeout, so a late ruling can be voided in flight. The source adds a 2-hour
margin, but it was not redeployed before the deadline; this is a known limit.

Evidence: README "One claim, end to end", step 5; `RecourseCase.sol:226-230`, `:265-267`, `:297-324`; `docs/decisions.md:34`, `:47`, `:56`; `deployments/arbitrum.json` (`constructorArgs.claimTimeout` 64,800 s, `params.caseDeadline` 7,200 s on the deployed contract).

### What if Hedera's public RPC endpoint goes down?

That is a real dependency. The services reach Hedera's contracts through one free JSON-RPC relay, testnet.hashio.io (the
other free one tested cuts callers off within seconds), and on 6 Nov it answered HTTP 502 for long stretches. Nothing is
lost, because each service resumes where it stopped, but on-chain deadlines keep running. The plan is a second, keyed
relay and a keeper that reports an outage at start-up instead of waiting on it.

Evidence: `docs/checks.md:13`; `packages/shared/src/env.ts:6-7` (`HEDERA_RPC_URL_1`, `HEDERA_RPC_URL_2`); `docs/runbook.md:64`, `:70` (resuming; pause windows). The 6 Nov outage is recorded in the end-to-end runs on testnet: `ops/e2e/results/run2/results.md`, `run2b/results.md` and `run2c/results.md` mark every row the relay did not answer as blocked, and run2c's one failure is a claim the relay dropped (the same claim was filed eight minutes later); `docs/runbook.md` (slow relay: `ACTION_READ_WAIT_MS`, `ACTION_DEADLINE_MS`).

## For agent builders

### How does an agent find a shop and pay it?

Through **ERC-8004**, a standard set of on-chain registries for AI agents (identity, reputation, validation). The agent reads
the shop's registration, takes its x402 address, and checks payee, asset and owner against its list of known parties; a
configured address is used only if the lookup fails. It then gets the price (the 402 reply), checks its spend limits, writes
the three pre-payment records and pays in testnet HBAR, Hedera's coin.

Evidence: `services/agent/src/setup.ts:78-114` (`discoverShop`); `services/agent/src/limits.ts:50-54`; README "How each technology is used"; identity registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` on Hedera testnet, agent company 149 and shop 150 (registrations `0xea5d875c0d3ac84055636ee4f082a8bfe3acb495885e5baf32f2e8ef8c5eaa64`, `0xd7e03c68f1240111c45d7af8d5a581614ce234a3a0a29ae93c8b91bc7ae5314a`); `ops/cast/README.md` (three more shops and three more agent companies, set up by `ops/cast/setup.ts`). The cast page (`#/cast`) lists all eight with their types: shops Halden Supply (150, physical goods with sizes), Kestrel Outfitters (171, physical goods with sizes, `0x34caea3e96c4ffe3f5328e93834b51b66b9cb92e99e48187fb74c21733a79e6d`), Fernhill Market (172, perishable goods, `0x9a5a0bf2120a16da054b28c546220fbf1a8ce9dfd43423599869d7590bd592cf`), Quillon Data (173, pay-per-call API, `0xa54827b90a4b8f3ae59ba44c1e62fd9ac15697072076b55fc330f6815e82a4d2`); agent companies Parcel Minds (149, general shopping), Wren Errands (174, personal shopper, `0x1495992e1e8a388938fe2636b687c9060e9767cb50efdddddd2d8eb3fe29d312`), Tallyhouse Procurement (175, procurement with buyer approval, `0x3e1168da393c205a6205f33b92f5fb4479ab303d7a58e17f5fd77965d00108d4`), Lumen Metrics (176, data agent buying API calls, `0xf19c8eec304ac6ac619ed857d67bbca534ca1dc57e2599d172d5e48f30931678`); `deployments/parties.json`.

### How do agents, shops and tools use Recourse from code?

Through one HTTP API, `/v1`, described in an OpenAPI 3.1 file. Reads return claims, parties, an order's six records and the
live parameters. Each action (file a claim, contest, settle, withdraw credit and the rest) returns unsigned transactions with
a plain preview of what will move; the caller signs with its own wallet, since the API never holds a key, signs or
broadcasts. The shop's x402 route refuses a paid order that does not name the three pre-payment records.

Evidence: `services/status-api/API.md:25-31`, `:51-86`, `:126-133`; `services/status-api/openapi.json` (served at `GET /v1/openapi.json`); `services/shop/src/orders.ts:16-22` (the order body), `services/shop/src/app.ts:404-411` (`bad_order_body`).

## What is live

### What is live on testnet today, and what is mocked?

Live on Hedera testnet (chain 296) and Arbitrum Sepolia (421614) only: the contracts, source verified as exact matches on
Sourcify (a public verifier HashScan reads); x402 payments in testnet HBAR; the record topic; six claims run to the end, three of them paying a shop from an agent company's deposit; CCIP
both ways, twice; disputes 212 and 213 in Kleros' test court 8 (test jurors); ERC-8004 identities for four shops and four agent companies; the docket's ruled cases and monthly counts on Arkiv testnet (a public data network), which the docket page reads. Vault money is mUSDC, a mock the deployer
mints, as Circle's faucet never delivered. Not live: public record copies, fault rates (they need more ruled cases than exist), reviews, the lock.

Evidence: README "What is live and what is not", "Deployed addresses and transactions" and Disclosures (court 8 is "a test court with test jurors"; Arkiv is a public data network); `deployments/hedera.json` (`usdc.mode` `mock`); `contracts/src/testnet/MockUsdc.sol`; `services/status-api/API.md:157-160` (the deployed Hedera contracts predate parts of the source); `ops/verify/verify.sh` and `ops/verify/README.md`: `RecourseClaims` `0xc4d457991eE42438EA433773e491ba8F2B27dDee`, `DepositVault` `0xA22fB188b49eddecc4f9DE22607e70E1d07Aea2e` and `MockUsdc` `0x6D6fb82e82E525B9c30619189EA8aF17117C3c73` built from `5275e74`, `RecourseCase` `0xd7f11FA06A97a45a6Af03c71d7eB3219C1a703B8` from `614403e` (https://repo.sourcify.dev/296/0xc4d457991eE42438EA433773e491ba8F2B27dDee, https://repo.sourcify.dev/421614/0xd7f11FA06A97a45a6Af03c71d7eB3219C1a703B8); the contracts were not verified on Arbiscan, and were not redeployed after the latest contract fixes (README "Known limits").

### Has a shop ever been paid from a deposit?

Three times on testnet, each with a staged mistake: the payout case below; a demo-cast claim where Wren Errands' deposit paid Kestrel Outfitters 3.1 mUSDC (claim `0xf5eee258fe2929efbb563d7464847f33ed5a28ffa13a80a500cc39666e2e8c69`); and the second court case, where the agent company contested, the jurors ruled it at fault in dispute 213, and its deposit paid the shop 3.575 mUSDC, the shop's court fee included (claim `0x00ad6c98af5cc7ae1e17dba7359c524ae8d6c37c32c1c01272830332e69efeae`). The first two claims ended "neither": the size change was approved (above),
one closed uncontested with the fee refunded, and the court case's fee went to the pool. The third order stages an
agent-company mistake (`live-order --fault ordered-size=L`): asked M, shown M with no change, approved under the spend
limit, but ordered L, and L packed and arrived. The unchanged rule answered 1 (agent company) at step 3, shown differs
from ordered. Nobody contested within the window, so the claim closed uncontested on 6 Nov at 19:36 UTC and paid the shop
2.575 mUSDC (basket 1.5 plus handling 1.075) from the agent company's deposit. The shop's credit was 3.575 mUSDC, the
payout plus its 1 mUSDC court fee returned, and it withdrew all of it. Afterwards the agent company held 15.425 mUSDC
against 18 required, so it had a deadline to top up.

Evidence: README rows "First claim: filed, pre-checked, closed uncontested" (`0x9cd704684c56a0ba1ff17ba9765d7c1e8521e78a3d0a4bbe7935d5a2a87e412c`), "First credit withdrawn" (`0x082d0148c6773a8c6f0b4e62db4a9cb28d88e6d41285380728a428cb3b57f050`) and "First court case settled" (`0x502db49f52f56bb2e1f014277139ccf140344186e6a5f257a9c59d7b9d90bd40`); staged order `0x6d94a648b3baecd5497adb542dcaaed82aa007d92c2b891acec0608d1a769274`, x402 payment `0.0.9185802@1793985607.160449829`, records on topic `0.0.11335218`, messages 13-18; `faultRule.ts:272-275` (step 3); `services/agent/scripts/live-order.ts:22-28` at `5402a69` (header: "stages an agent-company mistake, for a demonstration only"; "The fault rule is unchanged"), commit `559dfd3`; claim `0x8f78143ea47bd370edb87e91a720955110aa4978d79474a5d5fbbf0d1eec6f75`: filed `0x0c017f676e3bae04eb987404e4f654835c6817d4f9a0e350de0bd3596a331cb4`, pre-checked (answer 1) `0x562b5a5a59ba3bb7f24733b969967a55c4b4ce1c0b7c13f83ee5a6f280ecb5fd`, closed uncontested `0xd9f25361bca6c62a7afd671ece35c38dcfc7d0e8a4ef884165a1a7fec48425c7`, shop's withdrawal `0xb08f494f57e4e1abf85e7688e29a61e6812c0b7e58bf49d7d89e2fbd38b81539`; `GET /v1/parties/0xff845c7d57eb58f30dEEE83a96010FeE055FdaF6` read at 19:37 UTC (balance 15425000, required 18000000, in mUSDC base units of 6 decimals).

### How was it tested and reviewed?

Solidity unit, fuzz and invariant tests cover the contracts; TypeScript tests run per package; local end-to-end runs use
two throwaway chains, a CCIP simulator that drops and delays messages, and a mock court. Four AI models then reviewed the
code, each finding checked against it: 157 confirmed, none that loses funds or forges a ruling, 10 that give a wrong outcome
or break a flow. A limit not stated above: an 18-hour pre-check outage voids the order's only claim (planned fix: refiling).

Evidence: README "Setup and tests" and "Known limits" (every open finding with its planned fix, and the disputed ones); `contracts/test/hedera/ClaimsInvariant.t.sol`, `contracts/test/hedera/VaultInvariant.t.sol`, `contracts/test/arbitrum/RecourseCaseInvariant.t.sol`; `packages/shared/test/faultRule.test.ts`; `docs/ai-use.md:59` (a probe test that must fail does fail); on 6 Nov at `c1a1761` the status API suite passed 223 (2 skipped) and the web app 137; review of commit `f05649d`, severities and counts in README "Known limits"; `RecourseClaims.sol:129-132`, `:244-257`. End-to-end runs on testnet with `bash ops/e2e/run.sh` (`ops/e2e/results/`): run1 (dry run plus suites, 21ade87) 296 pass, 1 fail, 18 blocked; run2 (`--send --restarts --suites`, 801e5dd) 242 pass, 1 fail, 61 blocked; run2b (same, 74ac78a, with the raised waits) 285 pass, 1 fail, 17 blocked, the failure a gas budget fixed in 5302756; run2c (same, 58167d2, after that fix) 276 pass, 1 fail, 31 blocked. 110 of the 127 blocked rows, and the failures of run2 and run2c, are the Hedera relay not answering; the other blocked rows wait on a state the run did not reach (for example no claim with a step due); run1's failure was a keeper check that read gas levels too early after a restart, fixed in 0570d91.

### Which review findings do you dispute?

Four. The claims contract holding HBAR to pay CCIP fees is intended and documented. A template check said to crash cannot,
because the Kleros SDK rejects such a template first and that error is caught. A script that unlocks five role keys on one
host follows the recorded decision to run everything on one host. The intake and docket services already listen only on
the local interface; only a line of an ops README was out of date, and it has been corrected.

Evidence: README "Disputed findings"; `docs/decisions.md:9`, `:18`; README "Owner powers" (`sweepNative`, `setFeeToken`); `packages/court/src/validate.ts:72-80`; `ops/wire/00-readback.sh:32`; `services/intake/src/main.ts:47`, `services/docket/src/boot.ts:65`, `ops/units/README.md:23`.

## Business and next steps

### Who pays Recourse, and why would an agent company post a deposit?

A shop checks that the agent company is in good standing, meaning it holds the deposit Recourse requires, before it accepts
an order, and refuses the order otherwise. So the deposit is what lets an agent company buy from shops that do not know it,
and a low public fault rate, once published, is something it can show. Recourse has no fee model yet; the only income in
the code is unrefunded court fees, which go to the pool.

Evidence: `services/shop/src/app.ts:384-397` (`platform_not_in_good_standing`); `contracts/src/hedera/DepositVault.sol:124` (`setRequired`), `:413` (`inGoodStanding`); `params.json` (`minDeposit` 5 mUSDC); `docs/decisions.md:44`; README Disclosures.

### What is the path to mainnet?

As we see it: redeploy with the fixes already in the source, verify it again and lock all three contracts; move the
deposit to Circle's USDC, a mode the code already supports; pin the record documents publicly; move the keys off the single
host; make the pre-check verifiable or spread over several signers; and size the court fee against a production Kleros
court. The repository records no external audit, and human review has not been line by line.

Evidence: `docs/decisions.md:9`, `:34`, `:41`, `:63`, `:66`; README "How each technology is used" (`circle` mode); `docs/ai-use.md:22`; `docs/keys.md:57` ("Testnet only"); `ops/verify/README.md` (re-run after a redeploy).

### Does every contested claim have to go to court? That will not scale.

Not in the design, but in this version it does. The design sends only a random share of contested claims to court
(p = 0.25, drawn with Hedera's PRNG system contract), closes the rest with the court fee refunded, and has the docket weight
each sampled ruling by 1/p, so lowering p cannot make an agent company's rate look better. An agent company would then be
billed for the claims the draw left out, at its sampled fault rate. The draw and the bill are designed, not built: on the
deployed `RecourseClaims`, `batchOf` always returns 0 ("no claim is ever batched"), so every contested claim goes to
court. The docket's rate maths already takes the weights (each is 1 today), and the draw's probability is a parameter.

Evidence: `contracts/src/hedera/RecourseClaims.sol:474-481`; `contracts/src/hedera/interfaces/IPrngSystemContract.sol`; `packages/shared/src/params.ts:39` (`pBps`, 2,500); `services/docket/src/rates.ts:4-6`; README Known limits R65.

### What is the biggest open risk?

Trust before the lock. Until then the deployer key can decide any claim, and it sits on the host that runs the public
services, next to the pre-check key, which stays the one trusted step after the lock. Next is the design question above:
whether the agent's own approval under its spend limit should clear a size or colour change. Both are disclosed; neither is resolved.

Evidence: README "Owner powers and spend paths"; `docs/keys.md:15`; `packages/shared/src/faultRule.ts:179`.

## Open

### Who voted in the Kleros disputes, and did a team address vote?

Court 8 on Kleros's testnet has few staked jurors, so both disputes drew the same one, `0x245314a76fc9b8e48fea7abb3b9b07e34e13d8c6`: its `Draw` events for disputes 212 and 213 are on KlerosCore `0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479` (Arbitrum Sepolia), and its court 8 stake is read in `docs/checks.md` (row KLEROS-JUROR). The team made sure a juror would vote on its testnet cases, so read these rulings as a working path through the court, not as independent judgments. One juror on a testnet court is a demonstration of the path, not of a real panel; on Kleros's main court a case draws several jurors from a large stake.

### What is the full network cost of one claim?

Not measured: the sources give the Kleros fee and the ruling relay fee above, but not the Hedera gas, the HCS message fees, or the LINK (Chainlink token) fee of the outbound CCIP message `0x6631dc70…0adc`, readable on CCIP Explorer.

### How often do agents buy the wrong thing, and what does it cost shops today?

The sources hold no data on this; it is the project's premise, not a measured result.
