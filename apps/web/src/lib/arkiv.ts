// Docket reads straight from Arkiv, in the browser, with no access key (the public endpoint is
// rate limited). Every read filters by the writer's address; absence is never a filter.
import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { eq } from '@arkiv-network/sdk/query';
import { addr, bool, defineSchema, str, u64 } from '@arkiv-network/sdk/schema';
import { getAddress, http, type Address, type Chain } from 'viem';
import { faultRates, type RateResult, type RateRow } from '@recourse/docket';

const caseSchema = defineSchema('case', {
  claimId: str().indexed(),
  platform: addr().indexed(),
  shop: addr().indexed(),
  outcome: u64().indexed(),
  unresolved: bool().indexed(),
  tier: str().indexed(),
  month: str().indexed(),
  inclusionBps: u64(),
  settledAt: u64().indexed(),
} as never);

export interface DocketData {
  rows: RateRow[];
  rates: RateResult[];
}

const PAGE = 100;

/** Reads every `ruled` case the writer published, a page at a time. */
export async function readDocket(writer: Address, rpcUrl: string | undefined, threshold: number): Promise<DocketData> {
  const base = rabdi({ accessKey: '' }) as Chain;
  const chain = rpcUrl ? ({ ...base, rpcUrls: { default: { http: [rpcUrl] } } } as Chain) : base;
  const client = createPublicClient({ chain, transport: http() }) as unknown as {
    select(): { from(s: unknown): { where(w: unknown): { ownedBy(a: Address): { limit(n: number): { offset(n: number): { fetch(): Promise<{ entities: Record<string, { value: unknown }>[] }> } } } } } };
  };
  const rows: RateRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client
      .select()
      .from(caseSchema)
      .where(eq('tier', str('ruled') as never))
      .ownedBy(getAddress(writer))
      .limit(PAGE)
      .offset(offset)
      .fetch();
    for (const e of page.entities) {
      rows.push({
        platform: String(e.platform?.value),
        shop: String(e.shop?.value),
        outcome: Number(e.outcome?.value ?? 0),
        unresolved: Boolean(e.unresolved?.value),
        inclusionBps: Number(e.inclusionBps?.value ?? 10000) || 10000,
      });
    }
    if (page.entities.length < PAGE) break;
  }
  return { rows, rates: faultRates(rows, { publishThreshold: threshold }) };
}
