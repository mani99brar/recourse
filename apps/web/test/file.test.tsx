import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { precheckFromRecords, type ServedRecord } from '../src/lib/precheck.js';
import { Finding, RecordTable, approvalWords, findingSide, readUsed } from '../src/pages/File.js';

const ORDER = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const doc = (kind: string, more: Record<string, unknown>) => ({ v: '1', kind, orderId: ORDER, ...more });

/** An order whose screen changed the size, named the change, and was approved under the mandate; the shop packed another colour. */
function records(): ServedRecord[] {
  return [
    { kind: 0, held: true, doc: doc('asked', { attrs: { brand: 'Northwind', size: 'M', colour: 'Navy' } }) },
    { kind: 1, held: true, doc: doc('shown', { attrs: { brand: 'Northwind', size: 'L', colour: 'Navy' }, changes: ['size'] }) },
    { kind: 2, held: true, doc: doc('approval', { approval: 'approved', approvalBasis: 'mandate' }) },
    { kind: 3, held: true, doc: doc('ordered', { attrs: { brand: 'Northwind', size: 'L', colour: 'Navy' } }) },
    { kind: 4, held: true, doc: doc('packed', { attrs: { brand: 'Northwind', size: 'L', colour: 'Red' } }) },
    { kind: 5, held: null, doc: null },
  ];
}

describe('the file page shows the records the check used, and its finding', () => {
  it('reads only the records the check used', () => {
    const recs = records();
    const out = precheckFromRecords(ORDER, recs);
    expect(out.used).toEqual([0, 1, 2, 3, 4]);
    const input = readUsed(ORDER, recs, out.used);
    expect(input.packed?.attrs.colour).toBe('Red');
    expect(input.arrived).toBeUndefined();
    expect(readUsed(ORDER, recs, [3])).toEqual({ ordered: { attrs: { brand: 'Northwind', size: 'L', colour: 'Navy' } } });
  });

  it('names a mandate approval as the agent\'s, never as the buyer\'s', () => {
    expect(approvalWords({ approval: { approval: 'approved', approvalBasis: 'mandate' } })).toBe("Approved under the agent's spending mandate");
    expect(approvalWords({ approval: { approval: 'approved', approvalBasis: 'buyer' } })).toBe('Approved by the buyer');
    expect(approvalWords({ approval: { approval: 'not_approved' } })).toBe('Not approved');
    expect(approvalWords({})).toBeNull();
  });

  it('fills the cells behind the finding and says why a record was not used', () => {
    const recs = records();
    const out = precheckFromRecords(ORDER, recs);
    expect(out.result.reasonKey).toBe('gap3_ordered_vs_packed');
    const html = renderToString(<RecordTable orderId={ORDER} records={recs} outcome={out} />);
    // ordered and packed colour are the cells behind gap 3
    expect(html.match(/<td class="bad">/g)?.length).toBe(2);
    expect(html).toContain('<td class="bad">Red</td>');
    expect(html).toContain('Not used: could not be checked yet');
    expect(html).toContain('Used by the check');
    expect(html).toContain('Size');
    expect(html).toContain("Approved under the agent&#x27;s spending mandate");
  });

  it('puts the finding on the side it points to', () => {
    const out = precheckFromRecords(ORDER, records());
    expect(findingSide(out.result)).toBe('shop');
    const html = renderToString(<Finding result={out.result} />).replace(/<!-- -->/g, '');
    expect(html).toContain('data-who="shop"');
    expect(html).toContain('At fault: the shop');
    expect(html).toContain('What was ordered differs from what the shop packed.');
    expect(html).toContain('Cells behind the finding: colour in ordered, colour in packed.');
    const none = renderToString(<Finding result={{ gap: 255, answer: 0, side: 'none', reasonKey: 'not_enough_record', step: '1', flaggedCells: [], notCompared: [], unreadPrice: [] }} />);
    expect(none).toContain('data-who="none"');
    expect(none).toContain('No finding');
  });
});
