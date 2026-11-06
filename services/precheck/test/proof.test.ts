import { RECORD_DOC_MAX_BYTES, canonicalBytes, encodeRecordMsg, recordHash, ruleSlotFromDoc, type Parties } from '@recourse/shared';
import { getAddress } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { rawBlockCid } from '../src/docs.js';
import { proveClaim, proveSlot } from '../src/proof.js';
import {
  addLaterMessage,
  AGENT_ACCOUNT,
  ATTRS,
  cleanupRigs,
  FILED_AT,
  makeRig,
  orderIdOf,
  PARTIES,
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
    rig.world.addRecord({ kind: 0, orderId, payer: '9.9.3001' }); // a stranger's message is never held by the index
    rig.world.addRecord({ kind: 0, orderId, doc: new TextEncoder().encode('{}') });
    rig.world.addRecord({ kind: 0, orderId, doc: new TextEncoder().encode('[]') });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(500n, {}));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'doc_invalid', seq: 2n } });
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


describe('slot proof: documents a writer can point at but nobody can read', () => {
  const HOUR = 3600_000;

  it('a record whose document was never pinned is a retry, then doc_unavailable once the wait after the filing is over', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 1, orderId });
    rig.world.gatewayDocs.delete(rec.cid); // the message names a raw CID nobody can fetch
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const claim = proofClaim(orderId, refsOf(500n, { 1: { seq: rec.seq, hash: rec.hash } }));
    expect(await proveSlot(1, claim, ports)).toMatchObject({ final: false });
    rig.clock.setSeconds(FILED_AT + 3599n);
    expect(await proveSlot(1, claim, ports)).toMatchObject({ final: false });
    rig.clock.setSeconds(FILED_AT + 3600n);
    expect(await proveSlot(1, claim, ports)).toEqual({
      final: true,
      slot: { kind: 1, outcome: 'rejected', reason: 'doc_unavailable', seq: BigInt(rec.seq), hcsHash: rec.hash, cid: rec.cid },
    });
  });

  it('a decoy before a valid record holds the slot only until the wait is over; then the valid record is used', async () => {
    const rig = makeRig();
    const decoy = rig.world.addRecord({ kind: 1, orderId, doc: recordDoc(1, orderId, { ...ATTRS, size: 'xl' }) });
    rig.world.gatewayDocs.delete(decoy.cid);
    const valid = rig.world.addRecord({ kind: 1, orderId });
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const claim = proofClaim(orderId, refsOf(500n, {})); // the refs name no shown record
    expect(await proveSlot(1, claim, ports)).toMatchObject({ final: false });
    rig.clock.advance(HOUR);
    expect(await proveSlot(1, claim, ports)).toMatchObject({ final: true, slot: { outcome: 'held', seq: BigInt(valid.seq) } });
  });

  it('a service that comes back late still retries a failing document for ten minutes before giving up on it', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId });
    rig.world.gatewayDocs.delete(rec.cid);
    addLaterMessage(rig.world);
    rig.clock.setSeconds(FILED_AT + 5n * 3600n);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const claim = proofClaim(orderId, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }));
    expect(await proveSlot(0, claim, ports)).toMatchObject({ final: false });
    rig.clock.advance(9 * 60_000);
    expect(await proveSlot(0, claim, ports)).toMatchObject({ final: false });
    // The document turns up: it is used.
    rig.world.gatewayDocs.set(rec.cid, rec.doc);
    rig.clock.advance(2 * 60_000);
    expect(await proveSlot(0, claim, ports)).toMatchObject({ final: true, slot: { outcome: 'held' } });
  });

  it('gateway errors that never clear end the same way', async () => {
    const rig = makeRig();
    const rec = rig.world.addRecord({ kind: 0, orderId });
    rig.world.fail(/gateway\.example/, 503, 1000);
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    const claim = proofClaim(orderId, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }));
    expect(await proveSlot(0, claim, ports)).toMatchObject({ final: false });
    rig.clock.advance(HOUR);
    expect(await proveSlot(0, claim, ports)).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'doc_unavailable' } });
  });

  it('a CIDv0, a string that is no CID, or the CID of another document: the message never decodes, so doc_invalid at once', async () => {
    const doc = recordDoc(0, orderId);
    for (const cid of ['QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'notacidatall', rawBlockCid(new Uint8Array([7]))]) {
      const rig = makeRig();
      const body = new TextEncoder().encode(`{"cid":"${cid}","hash":"${recordHash(doc)}","kind":"0","orderId":"${orderId}","v":"1"}`);
      const m = rig.world.addMessage({ bytes: body, payer: AGENT_ACCOUNT });
      addLaterMessage(rig.world);
      const p = await prove(rig, refsOf(500n, { 0: { seq: m.seq, hash: recordHash(doc) } }));
      expect(p).toEqual({ final: true, slot: { kind: 0, outcome: 'rejected', reason: 'doc_invalid', seq: BigInt(m.seq) } });
    }
  });

  it('a record document over the record size cap is rejected at once, so the court evidence always fits', async () => {
    const rig = makeRig();
    const big = recordDoc(0, orderId, ATTRS, { request: { note: 'x'.repeat(RECORD_DOC_MAX_BYTES) } });
    expect(ruleSlotFromDoc(0, big, orderId).ok).toBe(true);
    const rec = rig.world.addRecord({ kind: 0, orderId, doc: big });
    const fits = rig.world.addRecord({ kind: 1, orderId, doc: recordDoc(1, orderId, ATTRS, { note: 'y'.repeat(RECORD_DOC_MAX_BYTES - 300) }) });
    addLaterMessage(rig.world);
    expect(fits.doc.length).toBeLessThanOrEqual(RECORD_DOC_MAX_BYTES);
    const p = await prove(rig, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }));
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'doc_too_large', seq: BigInt(rec.seq) } });
    expect(await prove(rig, refsOf(500n, { 1: { seq: fits.seq, hash: fits.hash } }), 1)).toMatchObject({ final: true, slot: { outcome: 'held' } });
  });
});

describe('slot proof: signatures and the claim\'s own parties', () => {
  it('an approval or arrived record with a bad signature is signature_invalid; a mandate approval by the writing agent holds', async () => {
    const rig = makeRig();
    const unsigned = rig.world.addRecord({ kind: 2, orderId, doc: recordDoc(2, orderId, ATTRS, { signature: `0x${'11'.repeat(65)}` }) });
    const forged = rig.world.addRecord({ kind: 5, orderId, doc: recordDoc(5, orderId, ATTRS, { buyerSignature: `0x${'22'.repeat(65)}` }) });
    const mandate = rig.world.addRecord({ kind: 2, orderId: otherOrder, doc: recordDoc(2, otherOrder, ATTRS, { approvalBasis: 'mandate' }) });
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig);
    await index.advance();
    expect(await proveSlot(2, proofClaim(orderId, refsOf(500n, { 2: { seq: unsigned.seq, hash: unsigned.hash } })), ports)).toMatchObject({
      final: true,
      slot: { outcome: 'rejected', reason: 'signature_invalid' },
    });
    expect(await proveSlot(5, proofClaim(orderId, refsOf(500n, { 5: { seq: forged.seq, hash: forged.hash } })), ports)).toMatchObject({
      final: true,
      slot: { outcome: 'rejected', reason: 'signature_invalid' },
    });
    expect(await proveSlot(2, proofClaim(otherOrder, refsOf(500n, { 2: { seq: mandate.seq, hash: mandate.hash } })), ports)).toMatchObject({
      final: true,
      slot: { outcome: 'held' },
    });
  });

  it('an arrived record that differs from what the buyer signed is signature_invalid', async () => {
    const rig = makeRig();
    const signed = JSON.parse(new TextDecoder().decode(recordDoc(5, orderId))) as Record<string, unknown>;
    const altered = canonicalBytes({ ...(signed as Record<string, string>), attrs: { ...ATTRS, colour: 'blue' } } as never);
    const rec = rig.world.addRecord({ kind: 5, orderId, doc: altered });
    addLaterMessage(rig.world);
    const p = await prove(rig, refsOf(500n, { 5: { seq: rec.seq, hash: rec.hash } }), 5);
    expect(p).toMatchObject({ final: true, slot: { outcome: 'rejected', reason: 'signature_invalid' } });
  });

  it('a second platform\'s writer is payer_mismatch for this claim\'s platform, even first on the topic', async () => {
    const rig = makeRig();
    const OTHER_WRITER = '9.9.5001';
    const parties: Parties = [
      ...PARTIES,
      { role: 'platform', evmAddress: getAddress('0x00000000000000000000000000000000000000b1'), hcsWriters: [OTHER_WRITER], displayName: 'Other Fictional Platform' },
    ];
    const front = rig.world.addRecord({ kind: 2, orderId, payer: OTHER_WRITER, doc: recordDoc(2, orderId, ATTRS, { approval: 'not_approved' }) });
    const own = rig.world.addRecord({ kind: 2, orderId });
    addLaterMessage(rig.world);
    const { index, ports } = await proofKit(rig, { parties });
    await index.advance();
    const named = await proveSlot(2, proofClaim(orderId, refsOf(500n, { 2: { seq: front.seq, hash: front.hash } })), ports);
    expect(named).toMatchObject({ final: true, slot: { outcome: 'held', seq: BigInt(own.seq), refs: { seq: BigInt(front.seq), reason: 'payer_mismatch' } } });
    const viaIndex = await proveSlot(2, proofClaim(orderId, refsOf(500n, {})), ports);
    expect(viaIndex).toMatchObject({ final: true, slot: { outcome: 'held', seq: BigInt(own.seq) } });
  });
});
