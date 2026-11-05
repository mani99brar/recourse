import { describe, expect, it } from 'vitest';
import { RATE_METHOD, faultRates, wilson, type RateRow } from '../src/rates.js';

const P = '0x00000000000000000000000000000000000000a1';
const S = '0x00000000000000000000000000000000000000b1';

function rows(outcomes: number[], extra: Partial<RateRow> = {}): RateRow[] {
  return outcomes.map((outcome) => ({ platform: P, shop: S, outcome, unresolved: outcome === 0, inclusionBps: 10000, ...extra }));
}

function find(results: ReturnType<typeof faultRates>, kind: string, party: string) {
  const r = results.find((x) => x.kind === kind && x.party === party);
  if (!r) throw new Error('missing result');
  return r;
}

// Plain Wilson on raw counts, written out independently of the module under test.
function plainWilson(k: number, n: number, z: number): [number, number] {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

describe('wilson', () => {
  it('matches known values', () => {
    // 8 of 20 at z 1.96: [0.2188, 0.6134]
    const [lo, hi] = plainWilson(8, 20, 1.96);
    expect(lo).toBeCloseTo(0.2188, 3);
    expect(hi).toBeCloseTo(0.6134, 3);
    const w = wilson(0.4, 20, 1.96);
    expect(w.low).toBeCloseTo(0.2188, 3);
    expect(w.high).toBeCloseTo(0.6134, 3);
  });
  it('stays inside 0..1 at the edges', () => {
    const a = wilson(0, 20, 1.96);
    const b = wilson(1, 20, 1.96);
    expect(a.low).toBe(0);
    expect(b.high).toBe(1);
    expect(a.high).toBeGreaterThan(0);
    expect(b.low).toBeLessThan(1);
  });
  it('rejects an empty sample', () => {
    expect(() => wilson(0, 0, 1.96)).toThrow();
  });
});

describe('faultRates', () => {
  it('with equal weights equals plain Wilson on raw counts', () => {
    const outcomes = [...Array(7).fill(1), ...Array(9).fill(2), ...Array(6).fill(3)]; // 22 units
    const out = faultRates(rows(outcomes));
    const plat = find(out, 'platform_fault', P);
    expect(plat.units).toBe(22);
    expect(plat.hits).toBe(7);
    expect(plat.nEff).toBe(22);
    const [lo, hi] = plainWilson(7, 22, 1.96);
    expect(plat.rate).toBeCloseTo(7 / 22, 12);
    expect(plat.low).toBeCloseTo(lo, 12);
    expect(plat.high).toBeCloseTo(hi, 12);
    expect(plat.method).toBe(RATE_METHOD);
    const ful = find(out, 'fulfilment_fault', S);
    expect(ful.hits).toBe(9);
    const acc = find(out, 'claim_accuracy', S);
    expect(acc.hits).toBe(16); // everything but outcome 3
    expect(acc.rate).toBeCloseTo(1 - 6 / 22, 12);
  });

  it('holds back the numbers below the threshold, unless sample mode is on', () => {
    const r = rows([1, 1, 2, 3]);
    const held = find(faultRates(r), 'platform_fault', P);
    expect(held).toMatchObject({ published: false, sample: false, rate: null, low: null, high: null, units: 4 });
    const shown = find(faultRates(r, { sampleMode: true }), 'platform_fault', P);
    expect(shown.published).toBe(false);
    expect(shown.sample).toBe(true);
    expect(shown.rate).toBeCloseTo(0.5, 12);
    expect(shown.low).not.toBeNull();
  });

  it('publishes at exactly the threshold on raw units', () => {
    const at = find(faultRates(rows(Array(20).fill(1))), 'platform_fault', P);
    expect(at.published).toBe(true);
    expect(at.sample).toBe(false);
    expect(at.rate).toBe(1);
    const below = find(faultRates(rows(Array(19).fill(1))), 'platform_fault', P);
    expect(below.published).toBe(false);
  });

  it('counts unresolved and uncontested beside the rate, not inside it', () => {
    const r = [...rows([1, 2, 3]), ...rows([0, 0])];
    const out = faultRates(r, { sampleMode: true, closedUncontested: { platform: { [P]: 5 }, shop: { [S]: 2 } } });
    const plat = find(out, 'platform_fault', P);
    expect(plat.units).toBe(3);
    expect(plat.unresolved).toBe(2);
    expect(plat.closedUncontested).toBe(5);
    expect(find(out, 'fulfilment_fault', S).closedUncontested).toBe(2);
  });

  it('weights by inclusion: effective n shrinks and the weighted share moves', () => {
    const r: RateRow[] = [
      { platform: P, shop: S, outcome: 1, unresolved: false, inclusionBps: 5000 }, // w 2
      { platform: P, shop: S, outcome: 2, unresolved: false, inclusionBps: 10000 }, // w 1
      { platform: P, shop: S, outcome: 2, unresolved: false, inclusionBps: 10000 }, // w 1
    ];
    const plat = find(faultRates(r, { sampleMode: true }), 'platform_fault', P);
    expect(plat.weightSum).toBe(4);
    expect(plat.weightedHits).toBe(2);
    expect(plat.rate).toBeCloseTo(0.5, 12);
    expect(plat.nEff).toBeCloseTo(16 / 6, 12); // (sum w)^2 / sum w^2
    expect(plat.nEff).toBeLessThan(plat.units);
  });

  it('has no rank field and does not sort by rate', () => {
    const a = '0x00000000000000000000000000000000000000c1';
    const b = '0x00000000000000000000000000000000000000c2';
    const r = [
      ...Array(3).fill({ platform: a, shop: S, outcome: 2, unresolved: false, inclusionBps: 10000 }),
      ...Array(3).fill({ platform: b, shop: S, outcome: 1, unresolved: false, inclusionBps: 10000 }),
    ];
    const out = faultRates(r, { sampleMode: true });
    for (const x of out) expect(Object.keys(x)).not.toContain('rank');
    // result order follows first appearance of the party, not its rate
    const platformOrder = out.filter((x) => x.kind === 'platform_fault').map((x) => x.party);
    expect(platformOrder).toEqual([a, b]);
  });

  it('lower-cases party addresses', () => {
    const out = faultRates([{ platform: '0xABCDEF0000000000000000000000000000000001', shop: S, outcome: 1, unresolved: false, inclusionBps: 10000 }], { sampleMode: true });
    expect(out.find((x) => x.kind === 'platform_fault')!.party).toBe('0xabcdef0000000000000000000000000000000001');
  });
});
