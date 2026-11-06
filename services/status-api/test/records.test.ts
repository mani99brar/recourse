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
