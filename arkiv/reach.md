# Reach

Who can read and build on the docket, and how.

- **Anyone with an RPC endpoint.** The entities are public. A reader needs no account, only the
  writer's address, which the README publishes. A query by owner and tier returns every ruled case.
- **The docket page.** It reads the `case` entities straight from Arkiv in the browser and computes
  each party's fault rate with a Wilson interval from them, so the numbers can be rechecked from
  the raw rows by anyone.
- **Other apps.** A shop-rating site, an insurer or another agent platform can pull the same rows
  to decide whether to trade with a party, with no integration on our side. The attribute list is
  small and stable (`arkiv/schema.md`) and carries a version number.
- **Other courts and marketplaces.** The schema is not specific to this court: `ruling`,
  `outcome` and `gap` are plain codes, so a second marketplace can publish into the same shape
  from its own wallet and be read side by side by filtering on owner.
- **Limits of reach.** Entities expire after 182 days, and the public endpoint is rate limited,
  so a heavy reader should use an access key.
