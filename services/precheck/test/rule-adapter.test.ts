import { runFaultRule, type RecordKind, type RuleInput } from '@recourse/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { proveClaim } from '../src/proof.js';
import { buildResultDoc } from '../src/resultDoc.js';
import { runRule } from '../src/ruleAdapter.js';
import { addLaterMessage, ATTRS, cleanupRigs, KINDS, makeRig, orderIdOf, proofClaim, proofKit, recordDoc, refsFor, refsOf, STRANGER_ACCOUNT } from './support.js';

afterEach(cleanupRigs);

const orderId = orderIdOf(5);

interface Case {
  name: string;
  expectedKey: string;
  /** Attribute overrides per kind. */
  attrs?: Partial<Record<RecordKind, Record<string, string>>>;
  omit?: RecordKind[];
}

const cases: Case[] = [
  { name: 'ordered record missing', expectedKey: 'not_enough_record', omit: [3] },
  { name: 'ordered departs from asked and the shown change is not covered', expectedKey: 'gap1_asked_vs_shown', attrs: { 1: { ...ATTRS, price: '25' }, 3: { ...ATTRS, price: '25' } } },
  { name: 'shown differs from ordered', expectedKey: 'gap2_shown_vs_ordered', attrs: { 3: { ...ATTRS, colour: 'blue' } } },
  { name: 'packed differs from ordered', expectedKey: 'gap3_ordered_vs_packed', attrs: { 4: { ...ATTRS, colour: 'green' } } },
  { name: 'packed record missing', expectedKey: 'missing_record_shop', omit: [4] },
  { name: 'everything agrees', expectedKey: 'no_gap_all_agree' },
];

function handInput(c: Case): RuleInput {
  const a = (k: RecordKind) => ({ ...ATTRS, ...(c.attrs?.[k] ?? {}) });
  const has = (k: RecordKind) => !c.omit?.includes(k);
  const input: RuleInput = {};
  if (has(0)) input.asked = { attrs: c.attrs?.[0] ?? a(0) };
  if (has(1)) input.shown = { attrs: c.attrs?.[1] ?? a(1), changes: [] };
  if (has(2)) input.approval = { approval: 'approved', approvalBasis: 'buyer' };
  if (has(3)) input.ordered = { attrs: c.attrs?.[3] ?? a(3) };
  if (has(4)) input.packed = { attrs: c.attrs?.[4] ?? a(4) };
  if (has(5)) input.arrived = { attrs: c.attrs?.[5] ?? a(5) };
  return input;
}

describe('rule adapter, from chain data to the shared rule', () => {
  for (const c of cases) {
    it(`${c.name}: ${c.expectedKey}`, async () => {
      const rig = makeRig();
      const docs: Partial<Record<RecordKind, Uint8Array>> = {};
      for (const k of KINDS) if (c.attrs?.[k] !== undefined) docs[k] = recordDoc(k, orderId, c.attrs[k]);
      for (const kind of KINDS) if (!c.omit?.includes(kind)) rig.world.addRecord({ kind, orderId, doc: docs[kind] });
      addLaterMessage(rig.world);
      const { index, ports } = await proofKit(rig);
      await index.advance();
      const refs = refsOf(500n, {}); // the index finds every record
      const proof = await proveClaim(proofClaim(orderId, refs), ports);
      expect(proof.final).toBe(true);
      if (!proof.final) return;

      const viaAdapter = runRule(proof.slots, orderId);
      expect(viaAdapter).toEqual(runFaultRule(handInput(c)));
      expect(viaAdapter.reasonKey).toBe(c.expectedKey);
    });
  }

  it('a rejected record is left out of the rule input, exactly like an absent one', async () => {
    const rig = makeRig();
    const added = KINDS.map((kind) => rig.world.addRecord({ kind, orderId, payer: kind === 3 ? STRANGER_ACCOUNT : undefined }));
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const proof = await proveClaim(proofClaim(orderId, refsFor(added)), ports);
    if (!proof.final) throw new Error('expected a final proof');
    expect(proof.slots[3]).toMatchObject({ outcome: 'rejected', reason: 'payer_mismatch' });
    expect(runRule(proof.slots, orderId)).toEqual(runFaultRule(handInput({ name: '', expectedKey: '', omit: [3] })));
    expect(runRule(proof.slots, orderId).reasonKey).toBe('not_enough_record');
  });

  it('the result document carries the rule output as strings and a reason sentence', async () => {
    const rig = makeRig();
    const added = rig.world.addOrder(orderId, { 4: recordDoc(4, orderId, { ...ATTRS, colour: 'green' }) });
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const proof = await proveClaim(proofClaim(orderId, refsFor(added)), ports);
    if (!proof.final) throw new Error('expected a final proof');
    const result = runRule(proof.slots, orderId);
    const doc = buildResultDoc({ claimId: proofClaim(orderId, refsFor(added)).claimId, orderId, slots: proof.slots, result });
    const json = JSON.parse(new TextDecoder().decode(doc.bytes)) as Record<string, unknown>;
    expect(json).toMatchObject({ v: '1', ruleVersion: '2', gap: '3', answer: '2', reasonKey: 'gap3_ordered_vs_packed', result: { gap: '3', answer: '2', step: '4' } });
    expect(typeof json.reasonText).toBe('string');
    expect(doc.bytes.length).toBeGreaterThan(0);
  });
});
