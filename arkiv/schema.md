# Arkiv schema

The docket publishes two kinds of entity on the Arkiv testnet (Rabdi, chain id 7794095). Both are
created and patched only by the scheme wallet, so every read filters on `$owner`; another project
can write entities with the same schema name, and the owner filter is how ours are told apart.

Source of truth for the tables below: `services/docket/src/schema.ts`. A test fails if either
schema goes over 31 attributes, a name over 32 bytes, or a string over 128 bytes.

`*` marks an indexed attribute. Every attribute is written on every entity; when a value is not
known yet it carries the sentinel (0, empty string, `false`).

## `case`

One entity per claim that reached a ruling (or a second refusal). It holds codes and counts only:
no buyer data, no record contents, no complaint text.

| Attribute | Type | Meaning |
|---|---|---|
| `claimId`* | str | Claim id, lower-case hex |
| `platform`* | addr | The agent company's address |
| `shop`* | addr | The shop's address |
| `gap`* | u64 | Pre-check gap: 0, 1, 2, 3 or 255 (a label, not what rates count) |
| `answer`* | u64 | Pre-check answer: 0 unknown, 1 platform, 2 shop, 3 neither |
| `ruling`* | u64 | Court ruling as received: 0 refused, 1 platform, 2 shop, 3 neither |
| `outcome`* | u64 | What rates count: the ruling if 1 to 3; the pre-check answer if the court refused twice and the answer is 1 to 3; otherwise 0 |
| `unresolved`* | bool | True when `outcome` is 0 |
| `zeroTwice` | bool | True when the court refused twice |
| `tier`* | str | Always `ruled` |
| `month`* | str | `YYYY-MM` (UTC) of the filing |
| `attempts` | u64 | Court attempts reported with the ruling (1 or 2) |
| `disputeId` | str | Kleros dispute id, decimal |
| `inclusionBps` | u64 | Chance the claim had of being sent to court; 10000 when every claim goes |
| `toShopUsdc` | u64 | USDC (6 decimals) actually credited to the shop at settlement; 0 until settled |
| `settledAt`* | u64 | Unix seconds of settlement; 0 until settled |
| `reasonCid` | str | IPFS CID of the reason document, built from codes only; empty if not pinned |
| `v` | u64 | Schema version, 1 |

18 attributes.

## `monthly-count`

One entity per month, platform and shop. The parts reconcile: every claim filed is in exactly one
bucket of each partition.

| Attribute | Type | Meaning |
|---|---|---|
| `month`*, `platform`*, `shop`*, `tier`* | str, addr, addr, str | Key; `tier` is always `reported` |
| `filed` | u64 | Claims filed in the month |
| `ruled` | u64 | Case written with `outcome` 1 to 3 |
| `unresolved` | u64 | Case written with `outcome` 0 |
| `ruledNotWritten` | u64 | Ruling seen, entity not written yet |
| `closedUncontested` | u64 | Window lapsed with no contest |
| `expired` | u64 | Claim expired before a ruling |
| `undrawn` | u64 | Left out of a batch draw |
| `open` | u64 | Everything else still in progress |
| `gap1`, `gap2`, `gap3`, `noGap` | u64 | Pre-check gap 1, 2, 3, or none |
| `notEnough` | u64 | Gap 255, no answer: not enough record |
| `missingRecord` | u64 | Gap 255 with a side named: a record is missing on that side |
| `notPreChecked` | u64 | No pre-check recorded yet |
| `v` | u64 | Schema version, 1 |

Status partition: `filed = ruled + unresolved + closedUncontested + open + ruledNotWritten + expired + undrawn`.
Gap partition: `filed = gap1 + gap2 + gap3 + noGap + notEnough + missingRecord + notPreChecked`.
20 attributes.

## Lifetime and limits

- Every create and patch asks for a lifetime of 182 days, under the 182.5-day maximum
  (7,884,000 blocks). Extending entities is a known follow-up, not built.
- Reads page with `limit` 100 and `offset` until a short page.
- No query uses a negation (the testnet has none). "Not yet" is an equality on a sentinel, for
  example `settledAt = 0`.
- The testnet keeps no history: the docket rebuilds state from chain logs, never from Arkiv.
