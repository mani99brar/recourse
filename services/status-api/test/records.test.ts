import { cidOfHash } from '@recourse/records';
import { canonicalBytes, encodeRecordMsg, recordHash, RECORD_KEYS } from '@recourse/shared';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/http.js';
import { pollHcs } from '../src/sources/hcs.js';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { TOPIC, buildClaim, ingest, ZERO32 } from './helpers/fixtures.js';
import { FakeMirror } from './helpers/mirror.js';
import { harness } from './helpers/service.js';

const AGENT_ACCOUNT = '0.0.1002';
const SHOP_ACCOUNT = '0.0.2001';
/** The second shop in the test party map writes its own records from this account. */
const SHOP2_ACCOUNT = '0.0.2002';

function docFor(kind: number, orderId: string) {
  return canonicalBytes({ v: '1', kind: RECORD_KEYS[kind]!, orderId, attrs: { brand: 'Sample', price: '10.00' } } as never);
}

interface Rig {
  m: FakeMirror;
  gateway: Map<string, Uint8Array>;
  fetch: FetchLike;
  hashes: `0x${string}`[];
  seqs: number[];
  cids: string[];
}

function rig(orderId: `0x${string}`, opts: { payerOverride?: Record<number, string>; skipKind?: number } = {}): Rig {
  const m = new FakeMirror();
  const gateway = new Map<string, Uint8Array>();
  const hashes: `0x${string}`[] = [];
  const seqs: number[] = [];
  const cids: string[] = [];
  const msgs = [];
  for (let k = 0; k < 6; k++) {
    const bytes = docFor(k, orderId);
    const hash = recordHash(bytes);
    const cid = cidOfHash(hash).toString();
    gateway.set(cid, bytes);
    cids.push(cid);
    hashes.push(hash);
    seqs.push(k + 1);
    msgs.push({
      seq: k + 1,
      ts: `1700000000.00000000${k}`,
      payer: opts.payerOverride?.[k] ?? (k === 4 ? SHOP_ACCOUNT : AGENT_ACCOUNT),
      body: encodeRecordMsg({ cid, hash, kind: k as 0, orderId }),
    });
  }
  m.topics.set(TOPIC, msgs.filter((x) => x.seq - 1 !== opts.skipKind));
  const fetch: FetchLike = async (url) => {
    if (url.startsWith('http://gateway.test/ipfs/')) {
      const bytes = gateway.get(url.split('/ipfs/')[1]!.split('?')[0]!);
      if (!bytes) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    }
    return m.fetch(url);
  };
  return { m, gateway, fetch, hashes, seqs, cids };
}

async function setup(opts: Parameters<typeof rig>[1] = {}, claimOpts: { refs?: boolean } = { refs: true }) {
  const sim = new Sim();
  const first = buildClaim(sim, 'filed', 1);
  const r = rig(first.orderId, opts);
  // Rebuild the claim with real refs when asked.
  const sim2 = new Sim();
  const b = claimOpts.refs ? buildClaim(sim2, 'filed', 1, { hashes: r.hashes, seqs: r.seqs }) : buildClaim(sim2, 'filed', 1);
  const store = new Store();
  ingest(store, sim2);
  const h = harness({ store, fetch: r.fetch, now: Number(b.now) });
  await pollHcs(store, { fetch: r.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_000_100 }, TOPIC);
  return { ...r, b, h, store };
}

describe('record checks', () => {
  it('holds a record whose payer, bytes and reference all agree', async () => {
    const s = await setup();
    const d = await s.h.svc.claimDetail(s.b.claimId);
    for (const rec of d.records) expect(rec).toMatchObject({ payerOk: true, hashOk: true, refsMatch: true, held: true });
    expect(d.records[0]!.cid).toBe(s.cids[0]);
  });

  it('never holds a record paid by the wrong account', async () => {
    const s = await setup({ payerOverride: { 1: '0.0.9999' } });
    const d = await s.h.svc.claimDetail(s.b.claimId);
    expect(d.records[1]).toMatchObject({ payerOk: false, held: false, hashOk: null, doc: null });
    expect(d.records[0]!.held).toBe(true);
  });

  it('a shop-paid shown record is not accepted (writer set is per kind)', async () => {
    const s = await setup({ payerOverride: { 1: SHOP_ACCOUNT } });
    const d = await s.h.svc.claimDetail(s.b.claimId);
    expect(d.records[1]!.payerOk).toBe(false);
  });

  it('flags altered bytes: hashOk false and not held', async () => {
    const s = await setup();
    s.gateway.set(s.cids[2]!, canonicalBytes({ v: '1', kind: 'approval', orderId: s.b.orderId, approval: 'approved' } as never));
    const d = await s.h.svc.claimDetail(s.b.claimId);
    expect(d.records[2]).toMatchObject({ hashOk: false, held: false, doc: null });
  });

  it('an index record the refs omit is held (hashOk true) but refsMatch false', async () => {
    const s = await setup({}, { refs: false });
    const d = await s.h.svc.claimDetail(s.b.claimId);
    // No refs on the claim: the order's records are found by order id.
    for (const rec of d.records) expect(rec).toMatchObject({ hashOk: true, held: true, refsMatch: false });
  });

  it('reports a record missing from the topic as not held', async () => {
    const s = await setup({ skipKind: 5 }, { refs: false });
    const d = await s.h.svc.claimDetail(s.b.claimId);
    expect(d.records[5]).toMatchObject({ held: false, cid: null });
  });

  it('a referenced record past the topic cursor is unknown (not read yet), and absent once read past', async () => {
    const s = await setup({ skipKind: 5 });
    expect(s.store.cursors.hcs.seq).toBe(5); // the Arrived record (#6) has not been read yet
    let d = await s.h.svc.claimDetail(s.b.claimId);
    expect(d.records[5]).toMatchObject({ seq: 6, cid: null, held: null, unread: true });
    expect(d.records[0]).toMatchObject({ held: true, unread: false });
    // The topic is read past #6 and it is not there: now it is definitely not held.
    s.m.topics.get(TOPIC)!.push({ seq: 7, ts: '1700000001.000000000', payer: AGENT_ACCOUNT, body: new TextEncoder().encode('{"not":"a record"}') });
    await pollHcs(s.store, { fetch: s.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_000_100 }, TOPIC);
    d = await s.h.svc.claimDetail(s.b.claimId);
    expect(d.records[5]).toMatchObject({ held: false, unread: false });
  });

  it('an order lookup with the topic never read through reports unknown, not missing', async () => {
    const s = await setup({ skipKind: 5 }, { refs: false });
    s.store.status.hcs.indexedThrough = null;
    s.store.status.hcs.failing = true;
    const r = await s.h.svc.recordsOfOrder(s.b.orderId);
    expect(r.records[5]).toMatchObject({ held: null, unread: true });
  });

  it("a stranger's earlier message for the order does not displace the writer's record", async () => {
    const s = await setup({ skipKind: 4 }, { refs: false });
    // Someone who is not the shop posts a well-formed Packed record for this order first.
    const forged = canonicalBytes({ v: '1', kind: 'packed', orderId: s.b.orderId, attrs: { brand: 'Other', price: '1.00' } } as never);
    const fh = recordHash(forged);
    const fcid = cidOfHash(fh).toString();
    s.gateway.set(fcid, forged);
    s.m.topics.get(TOPIC)!.push({ seq: 7, ts: '1700000001.000000000', payer: '0.0.9999', body: encodeRecordMsg({ cid: fcid, hash: fh, kind: 4, orderId: s.b.orderId }) });
    s.m.topics.get(TOPIC)!.push({ seq: 8, ts: '1700000002.000000000', payer: SHOP_ACCOUNT, body: encodeRecordMsg({ cid: s.cids[4]!, hash: s.hashes[4]!, kind: 4, orderId: s.b.orderId }) });
    await pollHcs(s.store, { fetch: s.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_000_100 }, TOPIC);
    const r = await s.h.svc.recordsOfOrder(s.b.orderId);
    expect(r.records[4]).toMatchObject({ seq: 8, payer: SHOP_ACCOUNT, payerOk: true, held: true });
    // With only the stranger's message on the topic, that one is shown, as not held.
    const only = await setup({ skipKind: 4 }, { refs: false });
    only.m.topics.get(TOPIC)!.push({ seq: 7, ts: '1700000001.000000000', payer: '0.0.9999', body: encodeRecordMsg({ cid: fcid, hash: fh, kind: 4, orderId: only.b.orderId }) });
    await pollHcs(only.store, { fetch: only.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_000_100 }, TOPIC);
    expect((await only.h.svc.recordsOfOrder(only.b.orderId)).records[4]).toMatchObject({ seq: 7, payerOk: false, held: false });
  });

  it("another shop's writer never counts for this order's record, though it writes for its own shop", async () => {
    // The claim's refs name a Packed message paid by the second shop's writer.
    const s = await setup({ payerOverride: { 4: SHOP2_ACCOUNT } });
    const d = await s.h.svc.claimDetail(s.b.claimId);
    expect(d.records[4]).toMatchObject({ seq: 5, payer: SHOP2_ACCOUNT, payerOk: false, held: false, doc: null });
    expect(d.records[3]).toMatchObject({ payerOk: true, held: true });
    // By order id: the other shop posts first, the order's own shop later; the own shop's counts.
    const o = await setup({ skipKind: 4 }, { refs: false });
    o.m.topics.get(TOPIC)!.push({ seq: 7, ts: '1700000001.000000000', payer: SHOP2_ACCOUNT, body: encodeRecordMsg({ cid: o.cids[4]!, hash: o.hashes[4]!, kind: 4, orderId: o.b.orderId }) });
    o.m.topics.get(TOPIC)!.push({ seq: 8, ts: '1700000002.000000000', payer: SHOP_ACCOUNT, body: encodeRecordMsg({ cid: o.cids[4]!, hash: o.hashes[4]!, kind: 4, orderId: o.b.orderId }) });
    await pollHcs(o.store, { fetch: o.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_000_100 }, TOPIC);
    expect((await o.h.svc.recordsOfOrder(o.b.orderId)).records[4]).toMatchObject({ seq: 8, payer: SHOP_ACCOUNT, payerOk: true, held: true });
    // An order no claim names yet: any shop's writer still counts.
    const unfiled = ('0x' + '6b'.repeat(32)) as `0x${string}`;
    o.m.topics.get(TOPIC)!.push({ seq: 9, ts: '1700000003.000000000', payer: SHOP2_ACCOUNT, body: encodeRecordMsg({ cid: o.cids[4]!, hash: o.hashes[4]!, kind: 4, orderId: unfiled }) });
    await pollHcs(o.store, { fetch: o.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_000_100 }, TOPIC);
    const free = await o.h.svc.recordsOfOrder(unfiled);
    expect(free.claimId).toBeNull();
    expect(free.records[4]).toMatchObject({ seq: 9, payerOk: true });
  });

  it('keeps messages from non-writers only up to a cap, counting the rest; writers are always kept', async () => {
    const m = new FakeMirror();
    const orderId = ('0x' + '5a'.repeat(32)) as `0x${string}`;
    const msgs = [];
    for (let i = 1; i <= 6; i++) {
      const bytes = docFor(0, orderId);
      const hash = recordHash(bytes);
      msgs.push({ seq: i, ts: `1700000000.00000000${i}`, payer: i === 6 ? AGENT_ACCOUNT : '0.0.9999', body: encodeRecordMsg({ cid: cidOfHash(hash).toString(), hash, kind: 0, orderId }) });
    }
    m.topics.set(TOPIC, msgs);
    const deps = { fetch: m.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_000_100 };
    const store = new Store();
    await pollHcs(store, deps, TOPIC, { isWriter: (_k, payer) => payer === AGENT_ACCOUNT, maxForeign: 2 });
    expect(store.hcs.size).toBe(3);
    expect(store.status.hcs.foreignDropped).toBe(3);
    expect([...store.hcs.values()].some((r) => r.payer === AGENT_ACCOUNT)).toBe(true);
    expect(store.cursors.hcs.seq).toBe(6);
    // Parties not known: nothing is dropped.
    const open = new Store();
    await pollHcs(open, deps, TOPIC, { isWriter: () => null, maxForeign: 2 });
    expect(open.hcs.size).toBe(6);
  });

  it('reports unknown (null), never false, when the gateway cannot be reached', async () => {
    const s = await setup();
    s.h.svc.d.docs['opts'].fetch = async () => {
      throw new Error('gateway down');
    };
    const d = await s.h.svc.claimDetail(s.b.claimId);
    expect(d.records[0]).toMatchObject({ payerOk: true, hashOk: null, held: null });
  });

  it('serves the records of an order by order id (browser pre-check input)', async () => {
    const s = await setup({}, { refs: false });
    const r = await s.h.svc.recordsOfOrder(s.b.orderId);
    expect(r.claimId).toBe(s.b.claimId);
    expect(r.records.map((x) => x.held)).toEqual([true, true, true, true, true, true]);
    expect(r.records[3]!.doc).toMatchObject({ kind: 'ordered' });
    await expect(s.h.svc.recordsOfOrder('0x12')).rejects.toMatchObject({ status: 400 });
  });

  it('skips a malformed topic message and counts it', async () => {
    const s = await setup();
    s.m.topics.get(TOPIC)!.push({ seq: 7, ts: '1700000001.000000000', payer: AGENT_ACCOUNT, body: new TextEncoder().encode('{"not":"a record"}') });
    await pollHcs(s.store, { fetch: s.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_000_100 }, TOPIC);
    expect(s.store.status.hcs.decodeFailures).toBe(1);
    expect(s.store.cursors.hcs.seq).toBe(7);
    expect(s.store.hcs.size).toBe(6);
  });
});
void ZERO32;
