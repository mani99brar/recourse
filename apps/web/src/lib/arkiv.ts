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

// One per month, platform and shop: the docket's counts, of which only the uncontested closures
// are read here (they are shown beside the rates, never inside them).
const countSchema = defineSchema('monthly-count', {
  month: str().indexed(),
  platform: addr().indexed(),
  shop: addr().indexed(),
  tier: str().indexed(),
  closedUncontested: u64(),
} as never);

export interface DocketData {
  rows: RateRow[];
  rates: RateResult[];
  /** False when the monthly counts could not be read: the rates then carry no uncontested figure. */
  countsRead: boolean;
}

type Entity = Record<string, { value: unknown }>;

/** Uncontested closures per platform and per shop (lower-case address), summed over the months. */
export function uncontestedFrom(entities: readonly Entity[]): { platform: Record<string, number>; shop: Record<string, number> } {
  const out = { platform: {} as Record<string, number>, shop: {} as Record<string, number> };
  for (const e of entities) {
    const n = Number(e.closedUncontested?.value ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    const p = String(e.platform?.value ?? '').toLowerCase();
    const s = String(e.shop?.value ?? '').toLowerCase();
    if (p) out.platform[p] = (out.platform[p] ?? 0) + n;
    if (s) out.shop[s] = (out.shop[s] ?? 0) + n;
  }
  return out;
}

const PAGE = 100;

/** Reads every `ruled` case and every monthly count the writer published, a page at a time. */
export async function readDocket(writer: Address, rpcUrl: string | undefined, threshold: number): Promise<DocketData> {
  const base = rabdi({ accessKey: '' }) as Chain;
  const chain = rpcUrl ? ({ ...base, rpcUrls: { default: { http: [rpcUrl] } } } as Chain) : base;
  const client = createPublicClient({ chain, transport: http() }) as unknown as {
    select(): { from(s: unknown): { where(w: unknown): { ownedBy(a: Address): { limit(n: number): { offset(n: number): { fetch(): Promise<{ entities: Entity[] }> } } } } } };
  };
  const all = async (schema: unknown, tier: string): Promise<Entity[]> => {
    const out: Entity[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await client.select().from(schema).where(eq('tier', str(tier) as never)).ownedBy(getAddress(writer)).limit(PAGE).offset(offset).fetch();
      out.push(...page.entities);
      if (page.entities.length < PAGE) break;
    }
    return out;
  };
  const rows: RateRow[] = (await all(caseSchema, 'ruled')).map((e) => ({
    platform: String(e.platform?.value),
    shop: String(e.shop?.value),
    outcome: Number(e.outcome?.value ?? 0),
    unresolved: Boolean(e.unresolved?.value),
    inclusionBps: Number(e.inclusionBps?.value ?? 10000) || 10000,
  }));
  // Without the counts every party would read "0 closed without a fight": leave them unknown.
  let closedUncontested: ReturnType<typeof uncontestedFrom> | null = null;
  try {
    closedUncontested = uncontestedFrom(await all(countSchema, 'reported'));
  } catch {
    closedUncontested = null;
  }
  const rates = faultRates(rows, { publishThreshold: threshold, ...(closedUncontested ? { closedUncontested } : {}) });
  return { rows, rates, countsRead: closedUncontested !== null };
}
