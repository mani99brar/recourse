import { afterEach, describe, expect, it } from 'vitest';
import { proveSlot } from '../src/proof.js';
import { addLaterMessage, AGENT_ACCOUNT, cleanupRigs, KINDS, makeRig, orderIdOf, proofClaim, proofKit, refsFor, refsOf, SHOP_ACCOUNT, STRANGER_ACCOUNT } from './support.js';

afterEach(cleanupRigs);

const orderId = orderIdOf(1);

describe('payer check', () => {
  for (const kind of KINDS) {
    const right = kind === 4 ? SHOP_ACCOUNT : AGENT_ACCOUNT;
    const wrong = kind === 4 ? AGENT_ACCOUNT : SHOP_ACCOUNT;

    it(`kind ${kind}: the right payer holds the record`, async () => {
      const rig = makeRig();
      const added = rig.world.addOrder(orderId);
      const { index, ports } = await proofKit(rig);
      await index.advance();
      const claim = proofClaim(orderId, refsFor(added));
      const p = await proveSlot(kind, claim, ports);
      expect(p).toMatchObject({ final: true, slot: { outcome: 'held', payer: right } });
    });

    it(`kind ${kind}: the other side's account is payer_mismatch`, async () => {
      const rig = makeRig();
      const rec = rig.world.addRecord({ kind, orderId, payer: wrong });
      addLaterMessage(rig.world);
      const { index, ports } = await proofKit(rig);
      await index.advance();
      const refs = refsFor([], 500n);
      // named by the refs
      const named = refsOf(500n, { [kind]: { seq: rec.seq, hash: rec.hash } });
      const p = await proveSlot(kind, proofClaim(orderId, named), ports);
      expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'payer_mismatch', seq: BigInt(rec.seq) } });
      // Found only through the index it is not even held there (the index keeps party writers'
      // messages for their own kinds), so the slot is absent: missing either way.
      const viaIndex = await proveSlot(kind, proofClaim(orderId, refs), ports);
      expect(viaIndex).toEqual({ final: true, slot: { kind, outcome: 'absent' } });
    });
  }

  it('a stranger account is rejected for every kind', async () => {
    const rig = makeRig();
    const added = KINDS.map((kind) => rig.world.addRecord({ kind, orderId, payer: STRANGER_ACCOUNT }));
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    for (const kind of KINDS) {
      const p = await proveSlot(kind, proofClaim(orderId, refsFor(added)), ports);
      expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'payer_mismatch' } });
    }
  });

  it('falls back to the transaction account of a chunk record when there is no payer field', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId, payer: null, txAccount: AGENT_ACCOUNT });
    const { index, ports } = await proofKit(rig);
    await index.advance();
    // The fake mirror gives chunk_info only for chunked messages, so this one reaches the third source.
    const p = await proveSlot(0, proofClaim(orderId, refsFor([rec])), ports);
    expect(p).toMatchObject({ final: true, slot: { outcome: 'held', payer: AGENT_ACCOUNT } });
    expect(rig.world.requests.some((u) => u.includes('/api/v1/transactions'))).toBe(true);
  });

  it('a payer found only through the transaction lookup is still checked against the writers', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId, payer: null, txAccount: STRANGER_ACCOUNT });
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const p = await proveSlot(0, proofClaim(orderId, refsFor([rec])), ports);
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'payer_mismatch' } });
  });

  it('no payer from any source is a retry with the sequence reported, never a pass', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId, payer: null });
    rig.world.fail(/api\/v1\/transactions/, 404, 5);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const p = await proveSlot(0, proofClaim(orderId, refsFor([rec])), ports);
    expect(p).toMatchObject({ final: false, payerUnresolved: BigInt(rec.seq) });
  });
});
