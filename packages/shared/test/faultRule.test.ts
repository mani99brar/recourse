import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalBytes,
  parsePrice,
  ruleSlotFromDoc,
  runFaultRule,
  withSlot,
  type RuleInput,
} from '../src/index.js';

interface Row {
  id: number;
  name: string;
  input: RuleInput;
  expect: Record<string, unknown>;
}
const fixtures = JSON.parse(readFileSync(new URL('../vectors/fault-rule.json', import.meta.url), 'utf8')) as {
  rows: Row[];
  priceParse: { text: string; parsed: string | null }[];
};

describe('fault rule fixtures', () => {
  it('has the 27 acceptance rows', () => {
    const ids = fixtures.rows.map((r) => r.id);
    for (let i = 1; i <= 27; i++) expect(ids).toContain(i);
  });

  it.each(fixtures.rows.map((r) => [r.id, r.name, r] as const))('row %i: %s', (_id, _name, row) => {
    expect(runFaultRule(row.input)).toEqual(row.expect);
  });

  it.each(fixtures.priceParse.map((p) => [p.text, p.parsed] as const))('parsePrice(%j) = %j', (text, parsed) => {
    expect(parsePrice(text)).toBe(parsed);
  });

  it('is deterministic and does not mutate its input', () => {
    const row = fixtures.rows[0]!;
    const before = JSON.stringify(row.input);
    expect(runFaultRule(row.input)).toEqual(runFaultRule(row.input));
    expect(JSON.stringify(row.input)).toBe(before);
  });
});

describe('ruleSlotFromDoc', () => {
  const orderId = `0x${'ab'.repeat(32)}` as const;
  const doc = (o: Record<string, unknown>) => canonicalBytes(o as never);

  it('maps each kind to its slot', () => {
    const asked = ruleSlotFromDoc(0, doc({ v: '1', kind: 'asked', orderId, attrs: { brand: 'Acme', note: 'x' } }), orderId);
    expect(asked).toEqual({ ok: true, key: 'asked', slot: { attrs: { brand: 'Acme' } } });
    const shown = ruleSlotFromDoc(1, doc({ v: '1', kind: 'shown', orderId, attrs: {}, changes: ['size'] }), orderId);
    expect(shown).toEqual({ ok: true, key: 'shown', slot: { attrs: {}, changes: ['size'] } });
    const approval = ruleSlotFromDoc(
      2,
      doc({ v: '1', kind: 'approval', orderId, approval: 'approved', approvalBasis: 'mandate' }),
      orderId,
    );
    expect(approval).toEqual({ ok: true, key: 'approval', slot: { approval: 'approved', approvalBasis: 'mandate' } });
    const ordered = ruleSlotFromDoc(3, doc({ v: '1', kind: 'ordered', orderId, attrs: { size: 'm' }, x402TxId: '0.0.5@1.2' }), orderId);
    expect(ordered.ok).toBe(true);
    if (!asked.ok || !shown.ok || !approval.ok || !ordered.ok) return;
    let input: RuleInput = {};
    for (const s of [asked, shown, approval, ordered]) input = withSlot(input, s);
    expect(Object.keys(input).sort()).toEqual(['approval', 'asked', 'ordered', 'shown']);
  });

  it.each([
    ['non-canonical bytes', 0, new TextEncoder().encode(`{ "v": "1", "kind": "asked", "orderId": "${orderId}" }`)],
    ['wrong kind', 0, doc({ v: '1', kind: 'shown', orderId, attrs: {}, changes: [] })],
    ['wrong order', 0, doc({ v: '1', kind: 'asked', orderId: `0x${'cd'.repeat(32)}`, attrs: {} })],
    ['wrong version', 0, doc({ v: '2', kind: 'asked', orderId, attrs: {} })],
    ['non-string attribute', 0, doc({ v: '1', kind: 'asked', orderId, attrs: { brand: true } })],
    ['shown without changes', 1, doc({ v: '1', kind: 'shown', orderId, attrs: {} })],
    ['unknown change key', 1, doc({ v: '1', kind: 'shown', orderId, attrs: {}, changes: ['weight'] })],
    ['bad approval', 2, doc({ v: '1', kind: 'approval', orderId, approval: 'yes' })],
    ['bad basis', 2, doc({ v: '1', kind: 'approval', orderId, approval: 'approved', approvalBasis: 'agent' })],
    ['empty tx id', 3, doc({ v: '1', kind: 'ordered', orderId, attrs: {}, x402TxId: '' })],
  ] as const)('rejects %s', (_label, kind, bytes) => {
    expect(ruleSlotFromDoc(kind, bytes, orderId).ok).toBe(false);
  });
});
