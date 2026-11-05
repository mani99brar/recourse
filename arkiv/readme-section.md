## Arkiv docket

Every ruled claim becomes a public, de-identified `case` entity on the Arkiv testnet (Rabdi, chain
id 7794095), and each month's filings are summarised in a `monthly-count` entity. The docket page
reads these entities and works out fault rates in the browser.

**Writer wallet:** `0x54E4545AFcf8960884A750320e70aFE16b2b3CaE` (the scheme wallet). It is the only
writer, so reads filter on `$owner`.

**Run the query** (case entities of this writer, newest settlement first):

```
arkiv.schema = str('case') AND tier = str('ruled') AND $owner = addr(0x54E4545AFcf8960884A750320e70aFE16b2b3CaE) ORDER BY settledAt:u64 DESC
```

With the SDK:

```ts
import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, desc, eq } from '@arkiv-network/sdk/query';
import { addr, defineSchema, str, u64, bool } from '@arkiv-network/sdk/schema';
import { http } from 'viem';

const Case = defineSchema('case', { tier: str().indexed(), settledAt: u64().indexed(), /* see arkiv/schema.md */ });
const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport: http() });
const rows = await client.select().from(Case).where(eq('tier', 'ruled'))
  .ownedBy('0x54E4545AFcf8960884A750320e70aFE16b2b3CaE').orderBy(desc('settledAt')).limit(100).fetch();
```

The full attribute list is in `arkiv/schema.md`; `services/docket/scripts/check-testnet.ts` is a
read-only probe of the same query.

**What is public.** A ruled case publishes the shop's and the agent company's addresses, the codes
of the finding and the ruling, the month and the settlement amount. It never publishes buyer data,
record contents or complaint text. The records it was decided on are pinned to IPFS by content
hash and are readable by anyone who has the CID.

**What to know.**
- Entities live 182 days (the testnet maximum). Extending them is not built.
- The scheme wallet that writes the docket also receives any unrefunded court-fee escrow. That
  overlap is deliberate to keep the demo small, and it is stated here so a reader can weigh it.
- The docket is rebuilt from chain logs, so losing Arkiv data loses nothing that cannot be rewritten.
