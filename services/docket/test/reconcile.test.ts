import { describe, expect, it } from 'vitest';
import { COUNT_FIELDS, GAP_PARTITION, STATUS_PARTITION } from '../src/schema.js';
import { applyEvent, countsOf, type ClaimState } from '../src/state.js';
import type { Hex } from 'viem';
import { E, NOV, PLATFORM, SHOP, cid } from './helpers.js';

// A small seeded generator so a failing run can be replayed.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const PLATFORMS = [PLATFORM, '0x00000000000000000000000000000000000000a1'];
const SHOPS = [SHOP, '0x00000000000000000000000000000000000000b1', '0x00000000000000000000000000000000000000b2'];
const MONTHS = [Date.UTC(2026, 9, 31, 23) / 1000, NOV, Date.UTC(2026, 11, 2) / 1000];

function randomClaims(rand: () => number): Map<Hex, ClaimState> {
  const claims = new Map<Hex, ClaimState>();
  const n = Math.floor(rand() * 40);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  for (let i = 1; i <= n; i++) {
    const filedAt = pick(MONTHS);
    if (rand() < 0.95) applyEvent(claims, E.filed(i, { platform: pick(PLATFORMS), shop: pick(SHOPS), filedAt }));
    if (rand() < 0.8) applyEvent(claims, E.precheck(i, pick([0, 1, 2, 3, 255]), pick([0, 1, 2, 3])));
    const end = rand();
    if (end < 0.15) applyEvent(claims, E.uncontested(i));
    else if (end < 0.25) applyEvent(claims, E.expired(i));
    else if (end < 0.3) applyEvent(claims, E.undrawn(i));
    else if (end < 0.8) {
      const ruling = pick([0, 1, 2, 3]);
      applyEvent(claims, E.ruling(i, ruling, ruling === 0 ? pick([1, 2]) : 1));
      if (rand() < 0.5) applyEvent(claims, E.applied(i, '1000000'));
    }
  }
  return claims;
}

describe('count partitions', () => {
  it('hold for 1,000 random claim sets', () => {
    for (let run = 0; run < 1000; run++) {
      const claims = randomClaims(lcg(run + 1));
      const written = new Set<Hex>([...claims.keys()].filter((_, i) => (i + run) % 3 !== 0));
      const rows = countsOf(claims.values(), (id) => written.has(id));
      let filed = 0;
      for (const row of rows.values()) {
        const byStatus = STATUS_PARTITION.reduce((s, f) => s + row[f], 0);
        const byGap = GAP_PARTITION.reduce((s, f) => s + row[f], 0);
        expect(byStatus, `run ${run} status`).toBe(row.filed);
        expect(byGap, `run ${run} gap`).toBe(row.filed);
        for (const f of COUNT_FIELDS) expect(row[f]).toBeGreaterThanOrEqual(0);
        filed += row.filed;
      }
      const expected = [...claims.values()].filter((c) => c.filed).length;
      expect(filed, `run ${run} total`).toBe(expected);
    }
  });

  it('puts the documented cases in the documented buckets', () => {
    const claims = new Map<Hex, ClaimState>();
    for (const e of [
      E.filed(1), E.precheck(1, 255, 0), E.ruling(1, 1), // not enough record, ruled platform
      E.filed(2), E.precheck(2, 255, 1), E.uncontested(2), // missing record
      E.filed(3), // not pre-checked, open
      E.filed(4), E.precheck(4, 2, 2), E.ruling(4, 0, 2), // zero twice, answer 2 -> ruled
      E.filed(5), E.precheck(5, 0, 0), E.ruling(5, 0, 2), // zero twice, no answer -> unresolved
      E.filed(6), E.expired(6),
      E.filed(7), E.ruling(7, 0, 1), // first refusal, not due
    ]) applyEvent(claims, e);
    const [row] = [...countsOf(claims.values(), (id) => id !== cid(1)).values()];
    expect(row).toMatchObject({
      filed: 7, notEnough: 2 - 1 + 0, missingRecord: 1, notPreChecked: 3 - 0, gap2: 1, noGap: 1,
      ruled: 1, unresolved: 1, ruledNotWritten: 1, closedUncontested: 1, expired: 1, open: 2,
    });
    expect(row!.gap2).toBe(1);
  });

  it('keeps months separate and holds back claims never seen filed', () => {
    const claims = new Map<Hex, ClaimState>();
    for (const e of [E.filed(1, { filedAt: Date.UTC(2026, 9, 31, 23, 59) / 1000 }), E.filed(2, { filedAt: Date.UTC(2026, 10, 1, 0, 1) / 1000 }), E.ruling(3, 1)]) applyEvent(claims, e);
    const rows = [...countsOf(claims.values(), () => false).values()];
    expect(rows.map((r) => [r.month, r.filed]).sort()).toEqual([['2026-10', 1], ['2026-11', 1]]);
  });
});
