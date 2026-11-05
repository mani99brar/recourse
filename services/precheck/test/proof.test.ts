import { encodeRecordMsg, recordHash } from '@recourse/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { rawBlockCid } from '../src/docs.js';
import { proveClaim, proveSlot } from '../src/proof.js';
import {
  addLaterMessage,
  AGENT_ACCOUNT,
  cleanupRigs,
  FILED_AT,
  makeRig,
  orderIdOf,
  proofClaim,
  proofKit,
  recordDoc,
  refsFor,
  refsOf,
  type Rig,
} from './support.js';

afterEach(cleanupRigs);

const orderId = orderIdOf(7);
const otherOrder = orderIdOf(8);

async function prove(rig: Rig, refs: ReturnType<typeof refsOf>, kind: 0 | 1 | 2 | 3 | 4 | 5 = 0, rounds = 1) {
  const { index, ports } = await proofKit(rig);
  await index.advance();
  let last;
  for (let i = 0; i < rounds; i++) last = await proveSlot(kind, proofClaim(orderId, refs), ports);
  return last!;
}

describe('slot proof: one reason per check', () => {
  it('topic_mismatch: the refs name another topic', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(501n, { 0: { seq: rec.seq, hash: rec.hash } }));
    // The record is still on the configured topic and the index finds it, so it is used and the refs are listed as disagreeing.
    expect(p).toMatchObject({ final: true, slot: { outcome: 'held', refs: { reason: 'topic_mismatch' } } });
  });

  it('topic_mismatch is the reason when nothing on the configured topic passes', async () => {
    const rig = makeRig();
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(501n, { 0: { seq: 1, hash: recordHash(new Uint8Array([1])) } }));
    expect(p).toEqual({ final: true, slot: { kind: 0, outcome: 'rejected', reason: 'topic_mismatch', seq: 1n } });
  });

  it('doc_invalid: a message body with a JSON number', async () => {
    const rig = makeRig();
    const doc = recordDoc(0, orderId);
    const body = new TextEncoder().encode(
      `{"cid":"${rawBlockCid(doc)}","hash":"${recordHash(doc)}","kind":0,"orderId":"${orderId}","v":"1"}`,
    );
    const m = rig.world.addMessage({ bytes: body, payer: AGENT_ACCOUNT });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(500n, { 0: { seq: m.seq, hash: recordHash(doc) } }));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'doc_invalid', seq: BigInt(m.seq) } });
  });

  it('doc_invalid: a chunked message', async () => {
    const rig = makeRig();
    const doc = recordDoc(0, orderId);
    const m = rig.world.addMessage({
      bytes: encodeRecordMsg({ cid: rawBlockCid(doc), hash: recordHash(doc), kind: 0, orderId }),
      payer: AGENT_ACCOUNT,
      chunkTotal: 2,
    });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(500n, { 0: { seq: m.seq, hash: recordHash(doc) } }));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'doc_invalid' } });
  });

  it('doc_invalid: a valid document of another order re-wrapped in this order\'s message', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId, doc: recordDoc(0, otherOrder) });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'doc_invalid', seq: BigInt(rec.seq), cid: rec.cid } });
  });

  it('doc_invalid: a document that is not canonical', async () => {
    const rig = makeRig();
    const loose = new TextEncoder().encode(`{ "v": "1", "kind": "asked", "orderId": "${orderId}" }`);
    const rec = rig.world.addRecord({ kind: 0, orderId, doc: loose });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'doc_invalid' } });
  });

  it('kind_mismatch: the message is for another kind', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 1, orderId, msgKind: 1 });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }), 0);
    expect(p).toMatchObject({ final: true, slot: { kind: 0, outcome: 'rejected', reason: 'kind_mismatch' } });
  });

  it('order_mismatch: the message is for another order', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId: otherOrder });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'order_mismatch' } });
  });

  it('hash_mismatch_hcs: the refs hash differs from the message hash', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId });
    addLaterMessage(rig.world);
    // The record is valid, so the index finds it; the refs disagreement says why the refs were not used.
    const p = await prove(rig, refsOf(500n, { 0: { seq: rec.seq, hash: recordHash(new Uint8Array([9])) } }));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'held', seq: BigInt(rec.seq), refs: { seq: BigInt(rec.seq), reason: 'hash_mismatch_hcs' } } });
  });

  it('after_filing: a record one second past the filing is rejected; the same second is accepted', async () => {
    const late = makeRig();
    const l = late.world.addRecord({ kind: 0, orderId, ts: `${FILED_AT + 1n}.000000000` });
    const pl = await prove(late, refsOf(500n, { 0: { seq: l.seq, hash: l.hash } }));
    expect(pl).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'after_filing' } });

    const same = makeRig();
    const s = same.world.addRecord({ kind: 0, orderId, ts: `${FILED_AT}.999999999` });
    const ps = await prove(same, refsOf(500n, { 0: { seq: s.seq, hash: s.hash } }));
    expect(ps).toMatchObject({ final: true, slot: { outcome: 'held', consensusAt: `${FILED_AT}.999999999` } });
  });

  it('bytes_mismatch: final only when two fetches return the same wrong bytes', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId });
    rig.world.gatewayDocs.set(rec.cid, new TextEncoder().encode('not the document'));
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const claim = proofClaim(orderId, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }));
    const first = await proveSlot(0, claim, ports);
    expect(first).toMatchObject({ final: false });
    const second = await proveSlot(0, claim, ports);
    expect(second).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'bytes_mismatch', cid: rec.cid } });
  });

  it('a gateway error page served once with status 200 is retried and then passes', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId });
    rig.world.fail(/gateway\.example/, 'html', 1);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const claim = proofClaim(orderId, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }));
    expect(await proveSlot(0, claim, ports)).toMatchObject({ final: false });
    expect(await proveSlot(0, claim, ports)).toMatchObject({ final: true, slot: { outcome: 'held' } });
  });
});

describe('slot proof: choosing the record', () => {
  it('uses the earliest valid index record when two exist and the refs name none', async () => {
    const rig = makeRig();
    const first = rig.world.addRecord({ kind: 0, orderId });
    rig.world.addRecord({ kind: 0, orderId, doc: recordDoc(0, orderId, { brand: 'other' }) });
    const p = await prove(rig, refsOf(500n, {}));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'held', seq: BigInt(first.seq), refs: { reason: 'not_named' } } });
  });

  it('the named record wins over an earlier valid index record', async () => {
    const rig = makeRig();
    rig.world.addRecord({ kind: 0, orderId });
    const named = rig.world.addRecord({ kind: 0, orderId, doc: recordDoc(0, orderId, { brand: 'other' }) });
    const p = await prove(rig, refsOf(500n, { 0: { seq: named.seq, hash: named.hash } }));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'held', seq: BigInt(named.seq) } });
    expect((p as { slot: { refs?: unknown } }).slot.refs).toBeUndefined();
  });

  it('index records after the filing are ignored, so the slot is absent, not rejected', async () => {
    const rig = makeRig();
    rig.world.addRecord({ kind: 0, orderId, ts: `${FILED_AT + 1n}.000000000` });
    const p = await prove(rig, refsOf(500n, {}));
    expect(p).toEqual({ final: true, slot: { kind: 0, outcome: 'absent' } });
  });

  it('with no named record, the earliest index candidate gives the reason', async () => {
    const rig = makeRig();
    rig.world.addRecord({ kind: 0, orderId, payer: '9.9.3001' });
    rig.world.addRecord({ kind: 0, orderId, doc: new TextEncoder().encode('{}') });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(500n, {}));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'payer_mismatch', seq: 1n } });
  });

  it('every slot ends in exactly one outcome', async () => {
    const rig = makeRig();
    const added = rig.world.addOrder(orderId);
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const proof = await proveClaim(proofClaim(orderId, refsFor(added, 500n, [2])), ports);
    expect(proof.final).toBe(true);
    if (proof.final) {
      expect(proof.slots.map((s) => s.kind)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(proof.slots.map((s) => s.outcome)).toEqual(['held', 'held', 'held', 'held', 'held', 'held']);
      expect(proof.slots[2]).toMatchObject({ refs: { reason: 'not_named' } });
    }
  });
});

describe('slot proof while the index is still growing', () => {
  it('does not settle on a candidate list the index outgrew during a document fetch', async () => {
    const rig = makeRig();
    // The only record so far is a document that fails its check, so the slot would be rejected.
    rig.world.addRecord({ kind: 0, orderId, doc: new TextEncoder().encode('{}') });
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const slow = ports.docs;
    ports.docs = {
      pin: slow.pin,
      async fetch(cid, options) {
        const bytes = await slow.fetch(cid, options);
        // While this document is being read, a valid record and a later message reach the index.
        rig.world.addRecord({ kind: 0, orderId });
        addLaterMessage(rig.world);
        await index.advance();
        return bytes;
      },
    };
    const claim = proofClaim(orderId, refsOf(500n, {}));
    expect(await proveSlot(0, claim, ports)).toMatchObject({ final: false });
    // The next look sees the valid record the first one missed.
    expect(await proveSlot(0, claim, ports)).toMatchObject({ final: true, slot: { outcome: 'held', seq: 2n } });
  });
});

