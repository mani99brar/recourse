import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEvidence } from '../../../packages/court/src/evidence.js';
import { recordHash, type ClaimToCourt, type RecordKind } from '@recourse/shared';
import { bytesToHex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { TOPIC_INDEX_FILE, TopicIndex } from '../src/topicIndex.js';
import {
  AGENT_ACCOUNT,
  SHOP_ACCOUNT,
  STRANGER_ACCOUNT,
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
  return TopicIndex.open({ mirror, topicId: TOPIC_ID, dir: rig.dir, clock: rig.clock, parties: PARTIES });
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

  it('holds a record message from a party writer with its payer, and only moves the cursor past anything else', async () => {
    const rig = makeRig();
    const orderId = orderIdOf(1);
    rig.world.addRecord({ kind: 0, orderId });
    rig.world.addMessage({ bytes: new TextEncoder().encode('hello'), payer: AGENT_ACCOUNT });
    rig.world.addRecord({ kind: 0, orderId, payer: STRANGER_ACCOUNT });
    rig.world.addRecord({ kind: 1, orderId, payer: SHOP_ACCOUNT }); // the shop writes packed only
    const idx = open(rig);
    expect(await idx.advance()).toBe(4);
    expect(idx.get(1n)).toMatchObject({ payer: AGENT_ACCOUNT, decoded: { ok: true } });
    expect(idx.get(1n)?.consensusAt).toMatch(/^\d+\.\d{9}$/);
    for (const seq of [2n, 3n, 4n]) expect(idx.get(seq)).toBeUndefined();
    expect(idx.size).toBe(1);
    expect(idx.lastSeq).toBe(4n);
    idx.close();
  });

  it('an oversized body is not held, but its place in the sequence survives a restart', async () => {
    const rig = makeRig();
    rig.world.addMessage({ bytes: new Uint8Array(5000).fill(65) });
    const idx = open(rig);
    await idx.advance();
    expect(idx.get(1n)).toBeUndefined();
    expect(idx.lastSeq).toBe(1n);
    idx.close();
    rig.world.requests.length = 0;
    const again = open(rig);
    expect(again.lastSeq).toBe(1n);
    expect(again.get(1n)).toBeUndefined();
    await again.advance();
    expect(rig.world.requests.some((u) => u.includes('sequencenumber=gte:2'))).toBe(true);
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

describe('topic index under spam: the topic has no submit key', () => {
  const junk = (i: number) => new TextEncoder().encode(`{"spam":"${String(i).padStart(6, '0')}${'x'.repeat(980)}"}`);

  it('holds and journals only party records, reads a backlog in one call, and resumes after it on restart', async () => {
    const rig = makeRig();
    const orderId = orderIdOf(1);
    rig.world.addRecord({ kind: 0, orderId });
    for (let i = 0; i < 3000; i++) rig.world.addMessage({ bytes: junk(i), payer: STRANGER_ACCOUNT, ts: `${FILED_AT - 1n}.000000001` });
    rig.world.addRecord({ kind: 0, orderId, payer: STRANGER_ACCOUNT }); // well formed, but no party writes with it
    rig.world.addMessage({ bytes: junk(-1), payer: STRANGER_ACCOUNT, ts: `${FILED_AT + 3n}.000000000` });
    const idx = open(rig);
    expect(await idx.advance()).toBe(3003);
    expect(idx.size).toBe(1);
    expect(idx.lastSeq).toBe(3003n);
    expect(idx.readThrough(FILED_AT, 120)).toBe(true);
    idx.close();
    // One message line and one cursor line, not three thousand lines of junk.
    const lines = readFileSync(join(rig.dir, TOPIC_INDEX_FILE), 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { t: string }).t)).toEqual(['msg', 'cursor']);

    rig.world.requests.length = 0;
    const again = open(rig);
    expect(again.size).toBe(1);
    expect(again.lastSeq).toBe(3003n);
    expect(again.readThrough(FILED_AT, 120)).toBe(true);
    expect(await again.advance()).toBe(0);
    expect(rig.world.requests.some((u) => u.includes('sequencenumber=gte:3004'))).toBe(true);
    again.close();
  });

  it('an older journal that held junk lines replays line by line and keeps only party records', async () => {
    const rig = makeRig();
    const orderId = orderIdOf(1);
    const added = rig.world.addOrder(orderId);
    const rows: string[] = [];
    for (const m of rig.world.messages) {
      rows.push(JSON.stringify({ t: 'msg', seq: String(m.seq), ts: m.ts, payer: m.payer, tx: m.txAccount, chunks: 1, size: m.bytes.length, hex: bytesToHex(m.bytes), at: 1 }));
    }
    for (let i = 0; i < 2000; i++) {
      const bytes = junk(i);
      rows.push(JSON.stringify({ t: 'msg', seq: String(7 + i), ts: `${FILED_AT + 1n}.000000001`, payer: STRANGER_ACCOUNT, chunks: 1, size: bytes.length, hex: bytesToHex(bytes), at: 1 }));
    }
    writeFileSync(join(rig.dir, TOPIC_INDEX_FILE), rows.join('\n') + '\n');
    const idx = open(rig);
    expect(idx.size).toBe(6);
    expect(idx.lastSeq).toBe(2006n);
    expect(idx.candidates(orderId, 3).map((m) => m.seq)).toEqual([BigInt(added[3]!.seq)]);
    idx.close();
  });

  it('rewrites a journal grown long with cursor lines into the held messages and one cursor', async () => {
    const rig = makeRig();
    rig.world.addRecord({ kind: 0, orderId: orderIdOf(1) });
    const opts = { mirror: rig.world.mirror(), topicId: TOPIC_ID, dir: rig.dir, clock: rig.clock, parties: PARTIES, compactAfter: 3 };
    const idx = TopicIndex.open(opts);
    for (let round = 0; round < 5; round++) {
      rig.world.addMessage({ bytes: junk(round), payer: STRANGER_ACCOUNT });
      await idx.advance();
    }
    idx.close();
    const path = join(rig.dir, TOPIC_INDEX_FILE);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(6);
    const compacted = TopicIndex.open(opts);
    expect(readFileSync(path, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { t: string }).t)).toEqual(['msg', 'cursor']);
    expect(compacted.lastSeq).toBe(6n);
    expect(compacted.size).toBe(1);
    rig.world.addRecord({ kind: 1, orderId: orderIdOf(1) });
    expect(await compacted.advance()).toBe(1);
    compacted.close();
    const last = TopicIndex.open(opts);
    expect(last.size).toBe(2);
    last.close();
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
