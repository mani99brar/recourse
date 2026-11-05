import { RECORD_KEYS, type RuleInput } from '@recourse/shared';
import { describe, expect, it } from 'vitest';
import vectors from '../../../packages/shared/vectors/fault-rule.json';
import { precheckFromRecords, type ServedRecord } from '../src/lib/precheck.js';

const ORDER = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

function recordsOf(input: RuleInput): ServedRecord[] {
  return RECORD_KEYS.map((key, kind) => {
    const slot = (input as Record<string, any>)[key];
    if (!slot) return { kind, held: false, doc: null };
    const doc: Record<string, unknown> = { v: '1', kind: key, orderId: ORDER };
    if (key === 'approval') {
      doc.approval = slot.approval;
      if (slot.approvalBasis) doc.approvalBasis = slot.approvalBasis;
    } else {
      doc.attrs = slot.attrs;
      if (key === 'shown') doc.changes = slot.changes;
    }
    return { kind, held: true, doc };
  });
}

describe('the rule in the browser bundle', () => {
  const rows = (vectors as { rows: { id: number; name: string; input: RuleInput; expect: { gap: number; answer: number; reasonKey: string; step: string } }[] }).rows;
  it('has the acceptance rows', () => expect(rows.length).toBeGreaterThanOrEqual(27));
  for (const row of rows) {
    it(`row ${row.id}: ${row.name}`, () => {
      const out = precheckFromRecords(ORDER, recordsOf(row.input));
      expect({ gap: out.result.gap, answer: out.result.answer, reasonKey: out.result.reasonKey, step: out.result.step }).toEqual({
        gap: row.expect.gap,
        answer: row.expect.answer,
        reasonKey: row.expect.reasonKey,
        step: row.expect.step,
      });
    });
  }

  it('leaves out records that are not held and says why', () => {
    const recs = recordsOf({ ordered: { attrs: { brand: 'x' } } });
    recs[3] = { ...recs[3]!, held: null };
    const out = precheckFromRecords(ORDER, recs);
    expect(out.used).toEqual([]);
    expect(out.skipped.find((s) => s.kind === 3)!.why).toMatch(/could not be checked/);
    expect(out.result.reasonKey).toBe('not_enough_record');
  });

  it('refuses a document written for another order', () => {
    const recs = recordsOf({ ordered: { attrs: { brand: 'x' } } });
    (recs[3]!.doc as { orderId: string }).orderId = '0x' + 'cd'.repeat(32);
    const out = precheckFromRecords(ORDER, recs);
    expect(out.skipped.find((s) => s.kind === 3)!.why).toBe('wrong orderId');
  });
});
