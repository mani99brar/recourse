# Friction

What got in the way while building on Arkiv, in the order it happened.

- **An access key is required.** `rabdi({ accessKey })` throws when the option is missing. Passing
  an empty string falls back to the public endpoint with a console warning, and that endpoint is
  rate limited. The key comes from signing in with a wallet on the Hub, so it cannot be created
  from a script; until it exists the docket runs against a local store with the same rows.
- **No negation, no history.** The query language has neither `NOT` nor `!=`, and every read is of
  the latest block. "Cases not settled yet" has to be written as an equality on a sentinel
  (`settledAt = 0`), which is why every attribute is written on every entity.
- **A schema is a client convention.** Another project can write entities with the same schema
  name, so the owner filter is part of every read. The SDK helps (`ownedBy`), but nothing makes it
  mandatory; a test here greps that no read leaves it out.
- **Only indexed attributes can be filtered, and the index is chosen at create time.** Changing
  which attributes are indexed later means rewriting entities, so the index list was decided up
  front from the queries the docket page needs.
- **Attribute budget.** 31 per named schema, 128 bytes per string. The `case` schema uses 18 and
  `monthly-count` 20, which left room, but the dispute id (up to 78 decimal digits) only fits as a
  string.
- **Lifetime cap.** 7,884,000 blocks. The SDK refuses a longer lifetime before sending; we ask for
  182 days, which is under it. A schema test pins this so a config change cannot cross it.
- **Reads are paged at 100.** Writes are one transaction each, so a month with many pairs makes
  many small transactions.
- **Checking a write that may or may not have landed.** If the process dies between sending a
  create and recording its key, the entity exists but the key is lost. The docket looks the entity
  up by owner and claim id before it writes again, so a replay does not create a second one.
