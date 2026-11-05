import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEvidence } from '../../../packages/court/src/evidence.js';
import { recordHash, type ClaimToCourt, type RecordKind } from '@recourse/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { TOPIC_INDEX_FILE, TopicIndex } from '../src/topicIndex.js';
import {
  AGENT_ACCOUNT,
  cleanupRigs,
  FILED_AT,
  KINDS,
  makeRig,
  orderIdOf,
  PARTIES,
  recordDoc,
  setupClaim,
  TOPIC_ID,
  type Rig,
} from './support.js';

afterEach(cleanupRigs);

function open(rig: Rig, mirror = rig.world.mirror()) {
  return TopicIndex.open({ mirror, topicId: TOPIC_ID, dir: rig.dir, clock: rig.clock });
}

describe('topic index', () => {
  it('reads the topic, keys records by order and kind, and keeps its cursor across a restart', async () => {
    const rig = makeRig();
    const orderId = orderIdOf(1);
    rig.world.addOrder(orderId);
    const first = open(rig);
    expect(await first.advance()).toBe(6);
    expect(first.lastSeq).toBe(6n);
    expect(first.candidates(orderId, 3).map((m) => m.seq)).toEqual([4n]);
    first.close();

    rig.world.addRecord({ kind: 3, orderId, doc: recordDoc(3, orderId, { brand: 'other' }) });
    rig.world.requests.length = 0;
    const second = open(rig);
    expect(second.lastSeq).toBe(6n);
    expect(await second.advance()).toBe(1);
    expect(rig.world.requests.some((u) => u.includes('sequencenumber=gte:7'))).toBe(true);
    expect(rig.world.requests.some((u) => u.includes('sequencenumber=gte:1&') || u.endsWith('gte:1'))).toBe(false);
    expect(second.candidates(orderId, 3).map((m) => m.seq)).toEqual([4n, 7n]);
    second.close();
  });

  it('keeps what a message holds: payer, transaction account, bytes, decode error', async () => {
    const rig = makeRig();
    const orderId = orderIdOf(1);
    rig.world.addRecord({ kind: 0, orderId });
    rig.world.addMessage({ bytes: new TextEncoder().encode('hello'), payer: '9.9.3001' });
    const idx = open(rig);
    await idx.advance();
    expect(idx.get(1n)).toMatchObject({ payer: AGENT_ACCOUNT, decoded: { ok: true } });
    expect(idx.get(2n)).toMatchObject({ payer: '9.9.3001', decoded: { ok: false } });
    expect(idx.get(2n)?.consensusAt).toMatch(/^\d+\.\d{9}$/);
    idx.close();
  });

  it('drops an oversized body but keeps its place in the sequence', async () => {
    const rig = makeRig();
    rig.world.addMessage({ bytes: new Uint8Array(5000).fill(65) });
    const idx = open(rig);
    await idx.advance();
    expect(idx.get(1n)).toMatchObject({ decoded: { ok: false, error: 'body over 1024 bytes' } });
    expect(idx.get(1n)?.bytes.length).toBe(0);
    idx.close();
    const again = open(rig);
    expect(again.get(1n)?.decoded.ok).toBe(false);
    again.close();
  });

  it('sets a damaged file aside and reads the topic again', async () => {
    const rig = makeRig();
    rig.world.addOrder(orderIdOf(1));
    const a = open(rig);
    await a.advance();
    a.close();
    const path = join(rig.dir, TOPIC_INDEX_FILE);
    const text = readFileSync(path, 'utf8').split('\n');
    text.splice(2, 0, 'not json');
    writeFileSync(path, text.join('\n'));
    const b = open(rig);
    expect(b.lastSeq).toBe(0n);
    expect(await b.advance()).toBe(6);
    b.close();
  });

  it('a partial last line (crash mid-write) is cut off and re-read', async () => {
    const rig = makeRig();
    rig.world.addOrder(orderIdOf(1));
    const a = open(rig);
    await a.advance();
    a.close();
    appendFileSync(join(rig.dir, TOPIC_INDEX_FILE), '{"t":"msg","seq":"7"');
    const b = open(rig);
    expect(b.lastSeq).toBe(6n);
    b.close();
  });

  it('tracks the tip probe with the time it started, and handles an empty topic', async () => {
    const rig = makeRig();
    const idx = open(rig);
    const empty = await idx.probeTip();
    expect(empty).toEqual({ atMs: rig.clock.now(), newestSeq: 0n });
    rig.world.addOrder(orderIdOf(1));
    const p = await idx.probeTip();
    expect(p.newestSeq).toBe(6n);
    expect(p.newestConsensus).toBeDefined();
    idx.close();
  });

  it('read-through: a message after the filing, or a quiet topic read to its tip', async () => {
    const rig = makeRig();
    const idx = open(rig);
    rig.world.addRecord({ kind: 0, orderId: orderIdOf(1), ts: `${FILED_AT - 10n}.000000001` });
    await idx.advance();
    expect(idx.readThrough(FILED_AT, 120)).toBe(false);

    rig.clock.setSeconds(FILED_AT + 121n);
    expect(idx.readThrough(FILED_AT, 120)).toBe(false); // no probe yet
    await idx.probeTip();
    expect(idx.readThrough(FILED_AT, 120)).toBe(true);

    // A probe that shows a newer message the index has not read is not enough.
    rig.world.addRecord({ kind: 1, orderId: orderIdOf(1), ts: `${FILED_AT - 5n}.000000001` });
    await idx.probeTip();
    expect(idx.readThrough(FILED_AT, 120)).toBe(false);
    await idx.advance();
    expect(idx.readThrough(FILED_AT, 120)).toBe(true);

    // A message after the filing settles it with no quiet wait at all.
    const early = makeRig();
    const e = open(early);
    early.world.addMessage({ bytes: new Uint8Array([1]), ts: `${FILED_AT + 1n}.000000000` });
    await e.advance();
    expect(e.readThrough(FILED_AT, 120)).toBe(true);
    expect(e.readThrough(FILED_AT + 1n, 120)).toBe(false);
    idx.close();
    e.close();
  });
});

describe('refs that omit a valid record the index holds', () => {
  it('uses the index record, lists the disagreement, and the evidence builder accepts it as from the index', async () => {
    const rig = makeRig();
    const { claimId, added, refs } = setupClaim(rig, { later: true, refsSkip: [3] });
    const svc = await rig.start();
    await svc.tick();

    const view = svc.result(claimId);
    expect(view?.state).toBe('intent');
    const cid = view?.cid;
    expect(cid).toBeDefined();
    const docBytes = await rig.docs.fetch(cid!);
    expect(docBytes).not.toBeNull();
    const doc = JSON.parse(new TextDecoder().decode(docBytes!)) as {
      records: Record<string, string>[];
      gap: string;
      answer: string;
      reasonKey: string;
      result: { gap: string };
    };
    expect(doc.records).toHaveLength(6);
    expect(doc.records[3]).toMatchObject({
      kind: '3',
      outcome: 'held',
      seq: String(added[3]!.seq),
      hcsHash: added[3]!.hash,
      cid: added[3]!.cid,
      refsSeq: '0',
      refsReason: 'not_named',
    });
    expect(doc.records[0]!.refsSeq).toBeUndefined();

    const claim: ClaimToCourt = {
      version: 1,
      claimId,
      platform: PARTIES[0]!.evmAddress,
      shop: PARTIES[1]!.evmAddress,
      gap: Number(doc.gap) as ClaimToCourt['gap'],
      answer: Number(doc.answer) as ClaimToCourt['answer'],
      refs,
      packHash: view!.packHash!,
      basketUsdc: 100_000_000n,
      netLossUsdc: 40_000_000n,
      filedAt: FILED_AT,
    };
    const records = KINDS.map((kind: RecordKind) => ({
      kind,
      bytes: added[kind]!.doc,
      cid: added[kind]!.cid,
      hcsSeq: BigInt(added[kind]!.seq),
    }));
    const bundle = buildEvidence({ claim, attempt: 1, externalId: 1n, records, precheck: { bytes: docBytes!, cid } });
    expect(bundle.slots.find((s) => s.kind === 3)?.state).toBe('fromIndex');
    expect(bundle.slots.find((s) => s.kind === 0)?.state).toBe('held');
    expect(recordHash(added[3]!.doc)).toBe(doc.records[3]!.hcsHash);
    svc.close();
  });
});
