# How the docket uses Arkiv

**Write path.** A small service follows the Hedera contracts' event logs through the mirror node.
When a claim receives its ruling, it builds one `case` row and creates the entity from the scheme
wallet. When the claim settles, it patches `toShopUsdc` and `settledAt` on the same entity. After
each batch of logs it recomputes the touched `monthly-count` rows from its own claim set and
creates or patches them.

**Idempotence.** Every write is journaled before and after it is sent. On restart the service
replays the journal, then, for any write that may have landed without being recorded, looks the
entity up by owner and claim id before sending again. Replaying the same logs twice changes
nothing: one entity per claim, one count row per month, platform and shop.

**Write status.** `GET /write-status/:claimId` answers from the journal: `none` (nothing is due
yet: still open, closed uncontested, expired), `pending`, `written` with the entity key, or
`failed` with the reason (`auth`, `quota`, `gas`, `rpc`). Failures retry on a timer and raise an
alert when they stop retrying; a failed write never blocks the next claim.

**Read path.** The docket page queries `case` and `monthly-count` entities by owner, tier and
month, 100 rows a page, and computes each party's rate in the browser with the same pure function
the service exports. The rate is the share of ruled cases that went a given way, weighted by how
likely each claim was to reach court, with a Wilson interval taken at the effective sample size.
Cases the court refused twice with no answer, and claims nobody contested, are counted beside the
rate and never inside it.

**Without Arkiv.** The service has a local store behind the same interface, with the same rows and
the same write status. Setting `DOCKET_STORE=arkiv` and an access key switches the Arkiv path on;
nothing else changes.
