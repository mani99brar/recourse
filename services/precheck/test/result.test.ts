import { REASON_KEYS, parseCanonical, runFaultRule } from '@recourse/shared';
import { describe, expect, it } from 'vitest';
import { REASON_TEXT, REASON_TEXT_2B, buildResultDoc } from '../src/resultDoc.js';
import type { SlotOutcome } from '../src/slots.js';
import { slotFromJson, slotToJson } from '../src/slots.js';
import { orderIdOf, recordDoc } from './support.js';

const orderId = orderIdOf(1);
const claimId = orderIdOf(2);
const hash = `0x${'aa'.repeat(32)}` as const;

const slots: SlotOutcome[] = [
  { kind: 0, outcome: 'held', seq: 3n, hcsHash: hash, cid: 'bafyaaa', payer: '9.9.1001', consensusAt: '1699999000.000000001', bytes: recordDoc(0, orderId) },
  { kind: 1, outcome: 'rejected', reason: 'payer_mismatch', seq: 4n, hcsHash: hash, cid: 'bafybbb' },
  { kind: 2, outcome: 'absent' },
  { kind: 3, outcome: 'held', seq: 5n, hcsHash: hash, cid: 'bafyccc', payer: '9.9.1001', consensusAt: '1699999001.000000001', bytes: recordDoc(3, orderId), refs: { seq: 2n, hash, reason: 'hash_mismatch_hcs' } },
  { kind: 4, outcome: 'absent' },
  { kind: 5, outcome: 'rejected', reason: 'topic_mismatch', seq: 9n },
];

describe('result document', () => {
  const result = runFaultRule({ ordered: { attrs: { brand: 'acme' } } });
  const doc = buildResultDoc({ claimId, orderId, slots, result });

  it('is canonical, all strings, with the exact fields', () => {
    const parsed = parseCanonical(doc.bytes);
    expect(parsed.ok).toBe(true);
    const json = JSON.parse(new TextDecoder().decode(doc.bytes)) as Record<string, any>;
    expect(Object.keys(json).sort()).toEqual(['answer', 'claimId', 'gap', 'orderId', 'reasonKey', 'reasonText', 'records', 'result', 'ruleVersion', 'v']);
    expect(json.records.map((r: { kind: string }) => r.kind)).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(json.records[0]).toEqual({ kind: '0', outcome: 'held', seq: '3', hcsHash: hash, cid: 'bafyaaa', payer: '9.9.1001', consensusAt: '1699999000.000000001' });
    expect(json.records[1]).toEqual({ kind: '1', outcome: 'rejected', reason: 'payer_mismatch', seq: '4', hcsHash: hash, cid: 'bafybbb' });
    expect(json.records[2]).toEqual({ kind: '2', outcome: 'absent' });
    expect(json.records[3]).toMatchObject({ refsSeq: '2', refsHash: hash, refsReason: 'hash_mismatch_hcs' });
    expect(json.records[5]).toEqual({ kind: '5', outcome: 'rejected', reason: 'topic_mismatch', seq: '9' });
    expect(json).toMatchObject({ v: '1', ruleVersion: '1', gap: '255', answer: '0', reasonKey: 'not_enough_record', result: { gap: '255', answer: '0' } });
  });

  it('is the same bytes every time and hashes to the packHash', () => {
    const again = buildResultDoc({ claimId, orderId, slots, result });
    expect(again.bytes).toEqual(doc.bytes);
    expect(again.packHash).toBe(doc.packHash);
  });

  it('has one sentence for every reason key', () => {
    for (const k of REASON_KEYS) expect(REASON_TEXT[k].length).toBeGreaterThan(20);
  });

  it('says what step 2b found, not the step-2a sentence of the same key', () => {
    const attrs = { brand: 'acme', size: 'm' };
    // The screen showed size L; the order kept to the asked M; no approved change.
    const r2b = runFaultRule({ asked: { attrs }, shown: { attrs: { ...attrs, size: 'l' }, changes: [] }, ordered: { attrs } });
    expect(r2b).toMatchObject({ step: '2b', reasonKey: 'gap1_asked_vs_shown' });
    const text2b = (JSON.parse(new TextDecoder().decode(buildResultDoc({ claimId, orderId, slots, result: r2b }).bytes)) as { reasonText: string }).reasonText;
    expect(text2b).toBe(REASON_TEXT_2B);
    expect(text2b).toContain('the ordered record keeps to it');
    // The order departed too and nothing flagged it: step 2a keeps the sentence that says so.
    const r2a = runFaultRule({ asked: { attrs }, shown: { attrs: { ...attrs, size: 'l' }, changes: [] }, ordered: { attrs: { ...attrs, size: 'l' } } });
    expect(r2a).toMatchObject({ step: '2a-ii', reasonKey: 'gap1_asked_vs_shown' });
    const text2a = (JSON.parse(new TextDecoder().decode(buildResultDoc({ claimId, orderId, slots, result: r2a }).bytes)) as { reasonText: string }).reasonText;
    expect(text2a).toBe(REASON_TEXT.gap1_asked_vs_shown);
    expect(text2a).toContain('The ordered record departs from the asked record');
  });

  it('slots survive the journal', () => {
    for (const s of slots) expect(slotFromJson(JSON.parse(JSON.stringify(slotToJson(s))))).toEqual(s);
  });
});
