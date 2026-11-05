// Fault rates from de-identified case rows. Pure and browser-safe: no Node built-ins, no I/O, and
// nothing but types imported, so the docket page can run it on rows read straight from Arkiv.
//
// A rate is the weighted share of ruled cases that went a given way. The interval is the Wilson
// score interval taken at the Kish effective sample size, which is the plain Wilson interval when
// every weight is 1. Output is unordered on purpose: nothing here ranks parties.

export const RATE_METHOD = 'wilson-kish-v1';

/** What the rates need from one `case` entity. */
export interface RateRow {
  platform: string;
  shop: string;
  /** Ruling 1-3, else the pre-check answer after a ruling of 0 twice, else 0. */
  outcome: number;
  /** True when the case ended with no usable outcome (ruling 0 twice, no answer). */
  unresolved: boolean;
  /** 10000 for a claim that was not batched. */
  inclusionBps: number;
}

export type RateKind = 'platform_fault' | 'fulfilment_fault' | 'claim_accuracy';
export type RateRole = 'platform' | 'shop';

export interface RateOptions {
  /** Raw ruled units a rate needs before it is published. Default 20. */
  publishThreshold?: number;
  /** Fill the rate below the threshold and mark it `sample`. Default false. */
  sampleMode?: boolean;
  /** Normal quantile of the interval. Default 1.96. */
  z?: number;
  /** Uncontested closures per party address (lower-case) and role, shown beside the rates, never in them. */
  closedUncontested?: { platform?: Readonly<Record<string, number>>; shop?: Readonly<Record<string, number>> };
}

export interface RateResult {
  kind: RateKind;
  role: RateRole;
  party: string;
  /** Ruled cases counted (outcome 1-3). */
  units: number;
  hits: number;
  weightSum: number;
  weightedHits: number;
  /** Kish effective sample size, (sum w)^2 / sum w^2. */
  nEff: number;
  rate: number | null;
  low: number | null;
  high: number | null;
  published: boolean;
  /** True when the numbers are shown below the publish threshold. */
  sample: boolean;
  /** Cases that ended with no outcome, beside the rate. */
  unresolved: number;
  closedUncontested: number;
  method: typeof RATE_METHOD;
}

export const DEFAULT_PUBLISH_THRESHOLD = 20;
export const DEFAULT_Z = 1.96;

/** Wilson score interval for proportion `p` observed over `n` effective trials. */
export function wilson(p: number, n: number, z: number): { low: number; high: number } {
  if (!(n > 0)) throw new RangeError('wilson: n must be positive');
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function weightOf(row: RateRow): number {
  const bps = row.inclusionBps;
  return Number.isFinite(bps) && bps > 0 ? 10000 / bps : 1;
}

interface Spec {
  kind: RateKind;
  role: RateRole;
  hit: (outcome: number) => boolean;
}

const SPECS: readonly Spec[] = [
  { kind: 'platform_fault', role: 'platform', hit: (o) => o === 1 },
  { kind: 'fulfilment_fault', role: 'shop', hit: (o) => o === 2 },
  { kind: 'claim_accuracy', role: 'shop', hit: (o) => o !== 3 },
];

export function faultRates(rows: readonly RateRow[], options: RateOptions = {}): RateResult[] {
  const threshold = options.publishThreshold ?? DEFAULT_PUBLISH_THRESHOLD;
  const sampleMode = options.sampleMode ?? false;
  const z = options.z ?? DEFAULT_Z;
  const uncontested = options.closedUncontested ?? {};

  const parties = { platform: new Set<string>(), shop: new Set<string>() };
  for (const r of rows) {
    parties.platform.add(r.platform.toLowerCase());
    parties.shop.add(r.shop.toLowerCase());
  }
  for (const role of ['platform', 'shop'] as const) {
    for (const address of Object.keys(uncontested[role] ?? {})) parties[role].add(address.toLowerCase());
  }

  const out: RateResult[] = [];
  for (const spec of SPECS) {
    for (const party of parties[spec.role]) {
      let units = 0;
      let hits = 0;
      let sumW = 0;
      let sumW2 = 0;
      let sumWH = 0;
      let unresolved = 0;
      for (const r of rows) {
        const who = (spec.role === 'platform' ? r.platform : r.shop).toLowerCase();
        if (who !== party) continue;
        if (r.unresolved || r.outcome < 1 || r.outcome > 3) {
          unresolved += 1;
          continue;
        }
        const w = weightOf(r);
        const h = spec.hit(r.outcome);
        units += 1;
        sumW += w;
        sumW2 += w * w;
        if (h) {
          hits += 1;
          sumWH += w;
        }
      }
      const nEff = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
      const published = units >= threshold;
      const show = units > 0 && (published || sampleMode);
      const p = sumW > 0 ? sumWH / sumW : 0;
      const interval = show ? wilson(p, nEff, z) : null;
      out.push({
        kind: spec.kind,
        role: spec.role,
        party,
        units,
        hits,
        weightSum: sumW,
        weightedHits: sumWH,
        nEff,
        rate: show ? p : null,
        low: interval ? interval.low : null,
        high: interval ? interval.high : null,
        published,
        sample: show && !published,
        unresolved,
        closedUncontested: uncontested[spec.role]?.[party] ?? 0,
        method: RATE_METHOD,
      });
    }
  }
  return out;
}
