import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CaseRow, CountRow } from '../src/schema.js';
import { ArkivStore } from '../src/store/arkiv.js';
import { LocalStore } from '../src/store/local.js';
import { StoreError, classifyError, diffCase, diffCount, type DocketStore } from '../src/store/types.js';
import { MemoryArkivIo } from './fakes.js';

const PLATFORM = '0xff845c7d57eb58f30dEEE83a96010FeE055FdaF6' as const;
const SHOP = '0x0d87ED2F5D792561B53043Ff028956125c820287' as const;

export function caseRow(n: number, over: Partial<CaseRow> = {}): CaseRow {
  return {
    claimId: `0x${n.toString(16).padStart(64, '0')}`,
    platform: PLATFORM,
    shop: SHOP,
    gap: 2,
    answer: 1,
    ruling: 1,
    outcome: 1,
    unresolved: false,
    zeroTwice: false,
    tier: 'ruled',
    month: '2026-11',
    attempts: 1,
    disputeId: '17',
    inclusionBps: 10000,
    toShopUsdc: '0',
    settledAt: 0,
    reasonCid: '',
    v: 1,
    ...over,
  };
}

export function countRow(over: Partial<CountRow> = {}): CountRow {
  return {
    month: '2026-11', platform: PLATFORM, shop: SHOP, tier: 'reported',
    filed: 3, gap1: 0, gap2: 2, gap3: 0, noGap: 1, notEnough: 0, missingRecord: 0, notPreChecked: 0,
    ruled: 2, unresolved: 0, closedUncontested: 1, open: 0, ruledNotWritten: 0, expired: 0, undrawn: 0, v: 1, ...over,
  };
}

function stores(): [string, () => DocketStore][] {
  return [
    ['arkiv (fake)', () => new ArkivStore(new MemoryArkivIo())],
    ['local', () => LocalStore.open(join(mkdtempSync(join(tmpdir(), 'docket-store-')), 'store.jsonl'))],
  ];
}

describe.each(stores())('%s store', (_name, make) => {
  it('creates, finds, patches and lists cases', async () => {
    const s = make();
    const row = caseRow(1);
    const { entityKey } = await s.createCase(row);
    const found = await s.findCase(row.claimId);
    expect(found?.entityKey).toBe(entityKey);
    expect(found?.row).toEqual(row);
    await s.patchCase(entityKey, { toShopUsdc: '3000000', settledAt: 1_800_000_000 });
    const patched = await s.findCase(row.claimId.toUpperCase().replace('0X', '0x'));
    expect(patched?.row.toShopUsdc).toBe('3000000');
    expect(patched?.row.settledAt).toBe(1_800_000_000);
    await s.createCase(caseRow(2, { month: '2026-12' }));
    expect(await s.listCases()).toHaveLength(2);
    expect(await s.listCases({ month: '2026-12' })).toHaveLength(1);
    expect(await s.listCases({ shop: SHOP })).toHaveLength(2);
    expect(await s.findCase(caseRow(9).claimId)).toBeNull();
  });

  it('creates, finds and patches counts', async () => {
    const s = make();
    const row = countRow();
    const { entityKey } = await s.createCount(row);
    expect((await s.findCount(row))?.row).toEqual(row);
    await s.patchCount(entityKey, { filed: 4, open: 1 });
    const again = await s.findCount(row);
    expect(again?.row.filed).toBe(4);
    expect(again?.row.open).toBe(1);
    expect(await s.listCounts({ month: '2026-11' })).toHaveLength(1);
    expect(await s.findCount({ ...row, month: '2027-01' })).toBeNull();
  });
});

describe('local store', () => {
  it('uses local keys and survives a reopen', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'docket-store-')), 'store.jsonl');
    const a = LocalStore.open(path);
    const row = caseRow(5);
    expect((await a.createCase(row)).entityKey).toBe(`local:${row.claimId}`);
    const key = (await a.createCount(countRow())).entityKey;
    expect(key.startsWith('local:count:2026-11|')).toBe(true);
    a.close();
    const b = LocalStore.open(path);
    expect((await b.findCase(row.claimId))?.row).toEqual(row);
    expect(await b.listCounts()).toHaveLength(1);
  });
});

describe('arkiv store', () => {
  it('pages 100 at a time until a short page', async () => {
    const io = new MemoryArkivIo();
    const s = new ArkivStore(io);
    for (let i = 1; i <= 230; i++) await s.createCase(caseRow(i));
    io.queries.length = 0;
    expect(await s.listCases()).toHaveLength(230);
    expect(io.queries.map((q) => [q.offset, q.limit])).toEqual([[0, 100], [100, 100], [200, 100]]);
    // exactly one full page needs a second, empty read to know it is the end
    const io2 = new MemoryArkivIo();
    const s2 = new ArkivStore(io2);
    for (let i = 1; i <= 100; i++) await s2.createCase(caseRow(i));
    io2.queries.length = 0;
    expect(await s2.listCases()).toHaveLength(100);
    expect(io2.queries).toHaveLength(2);
  });

  it('refuses a page size over 100', () => {
    expect(() => new ArkivStore(new MemoryArkivIo(), 101)).toThrow();
  });

  it('lists only ruled cases and reported counts, with a sentinel equality instead of a negation', async () => {
    const io = new MemoryArkivIo();
    const s = new ArkivStore(io);
    await s.listCases();
    await s.listCounts();
    expect(io.queries[0]!.equals).toContainEqual(['tier', 'ruled']);
    expect(io.queries[1]!.equals).toContainEqual(['tier', 'reported']);
  });

  it('reports a failed write as a typed error', async () => {
    const io = new MemoryArkivIo();
    const s = new ArkivStore(io);
    io.failWith.push(new Error('HTTP 401 unauthorized'));
    await expect(s.createCase(caseRow(1))).rejects.toMatchObject({ kind: 'auth' });
    io.failWith.push(new Error('monthly quota exceeded'));
    await expect(s.createCase(caseRow(1))).rejects.toMatchObject({ kind: 'quota' });
    io.failWith.push(new Error('insufficient funds for gas'));
    await expect(s.createCase(caseRow(1))).rejects.toMatchObject({ kind: 'gas' });
    io.failWith.push(new Error('socket hang up'));
    await expect(s.createCase(caseRow(1))).rejects.toBeInstanceOf(StoreError);
  });
});

describe('helpers', () => {
  it('diffs only changed attributes', () => {
    expect(diffCase(caseRow(1), caseRow(1, { settledAt: 5, toShopUsdc: '9' }))).toEqual({ settledAt: 5, toShopUsdc: '9' });
    expect(diffCount(countRow(), countRow({ open: 2 }))).toEqual({ open: 2 });
    expect(diffCase(caseRow(1), caseRow(1))).toEqual({});
  });
  it('classifies errors without echoing an auth message', () => {
    expect(classifyError(new Error('Request failed 401 key abc123')).message).not.toContain('abc123');
  });
});
