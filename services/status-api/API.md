# Recourse API, v1

One HTTP API for the web app and for agents: the status API in this directory. Both call the same `/v1`
paths; the web app has no path of its own. Testnet only: Hedera testnet (chain id 296), Arbitrum Sepolia
(421614), and a vault token, mUSDC, that is a testnet mock with 6 decimals.

The machine-readable description is [`openapi.json`](openapi.json) (OpenAPI 3.1). The server serves the file at
`GET /v1/openapi.json` and `GET /openapi.json`.

## Where to call it

| Who | Base | Example |
|---|---|---|
| Anyone, through the web app's origin | `/api` | `GET /api/v1/claims/0x…` |
| On the host | `http://127.0.0.1:8787` | `GET /v1/claims/0x…` |
| The shop (x402 orders) | the shop's origin (`http://127.0.0.1:8720` on the host, its tunnel publicly) | `POST /x402/orders/{sku}/{quantity}` |
| The agent's and the shop's commands | `STATUS_API_URL` (default `http://127.0.0.1:8787`) | `contest`, `withdraw-credit`, `claim-action`, `file-claim`, `live-order` |

`ops/units/web-server.mjs` forwards `/api/<path>` to the status API as `/<path>`, with a per-client
allowance (5 requests a second, bursts of 100). The shop's routes are in the same OpenAPI file, with their
own `servers` entry.

## Conventions

- JSON in and out. Field names are stable within v1; fields are only ever added. Ignore fields you do not know.
- Integers from a chain (amounts, ids, gas, chain times) are decimal strings. Small codes and counts are JSON
  numbers. Vault amounts are mUSDC base units (6 decimals); native amounts are wei, or weibar on Hedera (18 decimals).
- Requests take addresses in any case; responses send them checksummed, and 32-byte values in lower case.
- Every `/v1` read answers `{ <resource>: …, meta }`, where `meta` is `{ apiVersion, asOf, degraded, vaultToken, configLock }`.
- Action bodies are closed: a field an action does not list is refused with `unknown_field`. No action takes a
  key, a seed or a password, and the API never signs, never holds a key and never broadcasts.

## Reads

| Path | Answer |
|---|---|
| `GET /v1/health` | `health`: index rebuilding, per-source lag and last error |
| `GET /v1/params` | `params`: addresses, live parameters, vault token, records topic, `actions` this server builds |
| `GET /v1/claims?party=&status=` | `claims[]`; with `party`, also `party: { standing, groups }` |
| `GET /v1/claims/{claimId}` | `claim`: the summary fields plus records, pre-check, contest, court, bridge, money, docket, events |
| `GET /v1/parties/{address}` | `party`: deposit, required, standing, credit, open claims |
| `GET /v1/orders/{orderId}/records?platform=&shop=` | `order: { orderId, claimId, records[6] }` |
| `GET /v1/search?q=` | `search: { q, hits[] }` |
| `GET /v1/cast` | `cast: { registry, members[] }`: every shop and agent company with an ERC-8004 agent id (below) |

Each claim carries `statusKey`, `nextActor`, `nextCall`, `deadline` and `nextAction: { action, actor, path, deadline }`:
the action under `/v1/actions` that builds the next call, or null when nothing is due or the call is not one of them
(and for `withdrawCredit`, when the account that would sign it has no credit left in the vault). That credit is read
live and waited on for at most 3 s. When the read is slower, the last credit read for the account is used, and before
any has been read nextAction is null; so a slow Hedera relay never holds a claim read past the web server's 15-second timeout.

### The cast: `GET /v1/cast`

One member for each party in `deployments/parties.json` that has an `agentId`, in agent id order. Each member has:

- from the party map: `agentId`, `role` (`platform` is an agent company), `displayName`, `address`, `hederaAccountId`;
- from the ERC-8004 identity registry on Hedera (`registry`: its address, account id and HashScan page): `owner`
  (`ownerOf`), `ownerIsParty`, `agentURI` (`tokenURI`) and `readAt`, the time of the last read that answered;
- from the registration document the agentURI names (an inline `data:` URI, HTTPS, or `ipfs://` through the
  gateway; nothing else is fetched): `registration: { name, description, recourse }`, where `recourse` is the
  document's `{ role, kind, label, summary }` object (`kind` a kebab-case slug such as `personal-shopper`, `label`
  the type in plain words, `summary` one line), or null when it has none or it does not validate;
- `orders`: the distinct order ids among the records-topic messages paid by the party's record writers;
- `claims[]`: each indexed claim that names the party, with `statusKey`, `answer` (the pre-check's), `findingSide`,
  `paid`, `filedAt` and the other side as `counterparty` and `counterpartyName`.

The registry is read at most every 30 s an agent, and a request waits at most 3 s on it. A slower or failing relay
answers with the last values read (null before any), `current: false` on those members, and `identity` in
`meta.degraded`. An agent id the registry reverts for has `owner` and `agentURI` null and is still current. Not paged,
like `/v1/claims`.

## Actions

`POST /v1/actions/{action}` with a JSON body that always holds `from`, the account that will sign. The
answer is the same shape for every action:

```
{ action, chain, chainId, from, claimId,
  transactions: [ { chainId, to, data, value, gas, gasPrice, description, call: { contract, function, args }, simulated } ],
  preview: { summary, amounts: [ { name, amount, decimals, symbol, display, movement, account } ],
             fee: { amount, decimals, symbol, display, gas, gasPrice, basis }, changes[], statusAfter, notes[] },
  simulated, builtAt, notAfter, readBack, input }
```

To act: show `preview`; sign and send `transactions` in order from your own wallet, each after the one before
it has mined; then read `readBack` until it shows the change. The web app and the commands check first that
each transaction's data decodes to the call it shows (the commands also to the contract, function and
arguments they mean, on the chain and signer they mean), and sign nothing otherwise. Checks and gas estimates run against the latest
block as `from`. A call the contract would refuse is answered with an error, never with a transaction.
`simulated` is false only when a transaction depends on an earlier one in the list (fileClaim after approve).

| Action | Chain | Signer | Call | Preview amounts |
|---|---|---|---|---|
| `fileClaim` | Hedera | the shop | `approve` (only if the allowance is short) then `RecourseClaims.fileClaim` | basket, netLoss, handling, courtFee (escrow), maxPayout (reserve) |
| `contest` | Hedera | the side the finding went against | `RecourseClaims.contest` | courtFee (info, escrowed at filing) |
| `submitEvidence` | Arbitrum | anyone; shown as the party | `EvidenceModule.submitEvidence` | none |
| `withdrawCredit` | Hedera | the account with credit | `DepositVault.withdrawCredit` | credit (receive) |
| `closeUncontested` | Hedera | anyone | `RecourseClaims.closeUncontested` | toShop, feeRefund (credit) |
| `sendToCourt` | Hedera | anyone | `RecourseClaims.sendToCourt` | ccipFee (contract pays) |
| `resend` | Hedera | anyone | `RecourseClaims.resend` | ccipFee (contract pays) |
| `expireClaim` | Hedera | anyone | `RecourseClaims.expireClaim` | feeRefund (credit) |
| `settle` | Hedera | anyone | `RecourseClaims.settle` | toShop (credit), toPool (info) |
| `openCase` | Arbitrum | anyone | `RecourseCase.openCase(payload)` | disputeCost (fee pool pays) |
| `refile` | Arbitrum | anyone | `RecourseCase.refile(payload)` | disputeCost (fee pool pays) |
| `relayRuling` | Arbitrum | anyone | `RecourseCase.relayRuling` (`value` = `quoteRelayNative`) | ccipFee (send, or contract pays in LINK) |

The keeper makes the anyone-may calls on its own; the actions are for when it has not. Deadlines and
timeouts come from the claim's own terms (`claimTermsOf`), fixed when it was filed. A claims contract from
before per-claim terms has no `claimTermsOf` and checks every claim against its current `params()`; the
API then does the same and says so in a note.

### fileClaim: what you send, what the API derives

- **You send** `from` (the shop), `platform` and `orderNonce` (the two order headers the order was paid with),
  and optionally `netLossUsdc` (default: the whole basket), `basketUsdc`, `allowUnpacked`. For an order this
  deployment's shop took, `orderId` alone is enough: the API reads the nonce and platform from the shop service.
- **The API derives** `orderId` and `claimId`; the record `refs` from its index of the records topic (per kind,
  the earliest message for the order paid by the order's own writers: the platform's, and the shop's for packed);
  `basketUsdc` from the ordered record document (its amount and asset, as micro-USDC); the court fee,
  `handlingOf(basket)`, and whether an approve is needed. A `basketUsdc` you send must equal the derived one.
- It refuses before building: `no_ordered_record`, `ordered_unreadable`, `no_packed_record` (unless
  `allowUnpacked`), `net_loss_above_basket`, `claim_exists`, `exit_due`, `insufficient_balance`; an `orderId`
  that the nonce, platform and `from` do not hash to is `order_id_mismatch`, with `details.derivedOrderId`.
  `input.expectedFinding` is the shared fault rule on the referenced records; the pre-check service records the real finding.

## Errors

Every non-2xx answer under `/v1` is `{ "error": { "code", "message", "details"? } }`. `message` is one sentence
for people; `details` holds facts (`field`, `resource`, `upstream`, `closesAt`, `balance`, …). A refusal found
by simulating the call carries `details.revert = { contract, name, args }`.

| HTTP | Codes |
|---|---|
| 400 | `bad_json`, `missing_field`, `invalid_field`, `unknown_field` |
| 403 | `not_contester` |
| 404 | `not_found` |
| 405, 413 | `method_not_allowed`, `payload_too_large` (bodies over 64 KB) |
| 422 | `same_party`, `order_id_mismatch`, `order_nonce_unknown`, `not_paid`, `no_ordered_record`, `ordered_unreadable`, `ordered_tx_mismatch`, `no_packed_record`, `zero_basket`, `basket_too_large`, `basket_mismatch`, `net_loss_above_basket`, `evidence_too_large` |
| 409 | `claim_exists`, `wrong_status`, `window_closed`, `window_open`, `not_expired`, `exit_due`, `insufficient_balance`, `no_credit`, `not_associated`, `vault_not_ready`, `resend_too_soon`, `max_sends_reached`, `bridge_unavailable`, `contract_underfunded`, `insufficient_value`, `case_wrong_state`, `cap_reached`, `no_dispute`, `call_reverted` |
| 429 | `rate_limited` |
| 500, 503 | `internal`, `upstream_unavailable` |

`openapi.json` holds the same list with each code's meaning (`x-recourse-error-codes`), which codes each
action can return (`x-recourse-errors`), and which contract custom error maps to which code
(`x-recourse-revert-map`). An unknown code is handled by its HTTP status.

## Orders and x402 (the shop)

An order changes chain state by payment, so its answer is the x402 payment request, not a transaction.
`POST /x402/orders/{sku}/{quantity}` with headers `x-recourse-platform` and `x-recourse-order-nonce` answers
402 with `PAYMENT-REQUIRED` (base64 JSON: x402 v2, scheme `exact`, network `hedera:testnet`). The payer signs a
Hedera transfer for it with its own key and sends the same request with `PAYMENT-SIGNATURE` and the body
`{ orderId, refs: { asked, shown, approval: { seq, hash } } }`. The shop settles first, then answers 200 with
`PAYMENT-RESPONSE`. Keep the order nonce: fileClaim needs it. The shop's errors are `{ "error": code }`.

## Services behind it

- **Status API**: the index (claims, records topic, evidence), live chain reads, eth_call simulation, gas estimates.
- **Shop**: x402 orders; `GET /orders/{orderId}` gives the nonce and platform for an orderId-only fileClaim.
- **Pre-check**: its `/results/{claimId}` in claim detail; it records the finding on its own after filing.
- **Docket**: the write status in claim detail.
- **Intake** is not called: its `POST /intake` pins a pack, which a preview must not do. fileClaim runs the same
  shared fault rule in-process instead.

## What serving this needs

1. `ops/units/web-server.mjs` forwards only `accept` today, so a POST reaches the status API without its
   type: forward `content-type` and `content-length` on `/api`, send its own 429 and 502 in the error shape
   (`rate_limited`; `upstream_unavailable` with upstream `status_api`), and every action must answer inside its
   15-second upstream timeout. Until it forwards them, the status API reads an action body as JSON whatever
   its type, and every client behind it shares one rate limit.
2. The status API takes POST on `/v1/actions/*` with a 64 KB JSON limit, adds POST and `content-type` to the
   CORS reply on `/v1`, and uses the error shape on every `/v1` answer. Actions are limited per client
   (`cf-connecting-ip` when the request comes from the local proxy): 30 a minute with a burst of 10, at most
   4 building at once, each answering within 12 seconds. Bodies are closed, so no key can be sent.
3. Window and timeout math comes from `claimTermsOf(claimId)`, including the claim's `contest.windowEndsAt`
   on `/v1/claims/{claimId}` and `/claims/{claimId}`; until a claim's terms are read, the current parameters
   stand in. The Hedera pair in `deployments/hedera.json` today predates per-claim terms and reservations (its
   bytecode has no `claimTermsOf`, `escrowAndReserve`, `reservedOf`, `reservationOf` or `cancelExit`), so there
   `params()` is exact, a fileClaim preview reserves nothing, and the API stops asking for terms after the first
   revert.
4. `SHOP_URL` (optional, default `http://127.0.0.1:8720`) for orderId-only fileClaim; without the shop,
   that path answers `upstream_unavailable` (upstream `shop`) and nonce plus platform still work. Action
   simulation reads Arbitrum through `ARB_RPC_URL`.
5. The unversioned routes (`/claims`, `/params`, …) keep their shapes and `{ "error": code }`; they are not
   part of this contract. The web app reads `/v1` only, so the status API must serve `/v1` before a web build
   from this version goes live.

Not in v1: the platform's deposit calls (`postDeposit`, `requestExit`, `exit`, `cancelExit`), CCIP manual
execution (use the claim's `ccipExplorer` link), `recordPreCheck` (the pre-check signer only), `markStale`,
and writing records to the topic (the platform's own Hedera account submits them).
