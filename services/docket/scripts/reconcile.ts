// Compares the docket's monthly counts with the status API's claim list, grouped the same way.
// Usage: tsx scripts/reconcile.ts --api http://127.0.0.1:8787 [--docket http://127.0.0.1:8707]
// Exits 1 on any mismatched row. The claim list is only ever compared, never used as a source.

import { monthOf } from '../src/schema.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const api = arg('api', 'http://127.0.0.1:8787');
const docket = arg('docket', `http://127.0.0.1:${process.env.DOCKET_PORT ?? '8707'}`);

interface ApiClaim { platform: string; shop: string; filedAt: string | number; gap: number | null; answer: number | null; statusKey: string }
type Tally = Record<string, number>;

const RULED_KEYS = new Set(['ruled', 'zero_twice_answer_applied', 'settled']);

function bucketKey(c: ApiClaim): string {
  return `${monthOf(Number(c.filedAt))}|${c.platform.toLowerCase()}|${c.shop.toLowerCase()}`;
}

function gapBucket(c: ApiClaim): string {
  if (c.gap === null || c.answer === null) return 'notPreChecked';
  if (c.gap === 1 || c.gap === 2 || c.gap === 3) return `gap${c.gap}`;
  if (c.gap === 0) return 'noGap';
  return c.answer === 1 || c.answer === 2 ? 'missingRecord' : 'notEnough';
}

function statusBucket(c: ApiClaim): string {
  if (RULED_KEYS.has(c.statusKey)) return 'ruledAny'; // ruled + ruledNotWritten, split by the docket's own write status
  if (c.statusKey === 'unresolved') return 'unresolved';
  if (c.statusKey === 'closed_uncontested') return 'closedUncontested';
  if (c.statusKey === 'expired') return 'expired';
  if (c.statusKey === 'closed_undrawn') return 'undrawn';
  return 'open';
}

async function main(): Promise<void> {
  const claims = ((await (await fetch(`${api}/claims`)).json()) as { claims?: ApiClaim[] } | ApiClaim[]);
  const list = Array.isArray(claims) ? claims : (claims.claims ?? []);
  const counts = ((await (await fetch(`${docket}/docket/counts`)).json()) as { rows: Record<string, number | string>[] }).rows;

  const expected = new Map<string, Tally>();
  for (const c of list) {
    const t = expected.get(bucketKey(c)) ?? {};
    expected.set(bucketKey(c), t);
    t.filed = (t.filed ?? 0) + 1;
    for (const b of [gapBucket(c), statusBucket(c)]) t[b] = (t[b] ?? 0) + 1;
  }
  let bad = 0;
  const seen = new Set<string>();
  for (const r of counts) {
    const key = `${r.month}|${String(r.platform).toLowerCase()}|${String(r.shop).toLowerCase()}`;
    seen.add(key);
    const e = expected.get(key) ?? {};
    const ruledAny = Number(r.ruled) + Number(r.ruledNotWritten);
    const got: Tally = { filed: Number(r.filed), ruledAny, unresolved: Number(r.unresolved), closedUncontested: Number(r.closedUncontested), expired: Number(r.expired), undrawn: Number(r.undrawn), open: Number(r.open) };
    for (const g of ['gap1', 'gap2', 'gap3', 'noGap', 'notEnough', 'missingRecord', 'notPreChecked']) got[g] = Number(r[g]);
    for (const [k, v] of Object.entries(got)) {
      if ((e[k] ?? 0) !== v) {
        bad += 1;
        console.log(`MISMATCH ${key} ${k}: docket ${v}, status api ${e[k] ?? 0}`);
      }
    }
  }
  for (const key of expected.keys()) if (!seen.has(key)) (bad += 1), console.log(`MISSING ${key}: no count row`);
  console.log(`${counts.length} count row(s), ${list.length} claim(s), ${bad} mismatch(es)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
