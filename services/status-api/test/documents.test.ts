// Record documents as this deployment stores them: a content store on the host
// (IPFS_PIN_API_URL=file://...), read before any gateway, every document checked against the hash
// the caller expects and capped while it is read; the cache is bounded by bytes.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpfsError, MAX_DOCUMENT_BYTES, cidOfHash, ipfsOptionsFromEnv } from '@recourse/records';
import { canonicalBytes, encodeRecordMsg, recordHash, RECORD_KEYS } from '@recourse/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DocFetcher, type DocFetch } from '../src/ipfs.js';
import { pollHcs } from '../src/sources/hcs.js';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { TOPIC, buildClaim, ingest } from './helpers/fixtures.js';
import { FakeMirror } from './helpers/mirror.js';
import { harness } from './helpers/service.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function storeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'status-api-docs-'));
  dirs.push(d);
  return d;
}

function docFor(kind: number, orderId: string, pad = 0) {
  return canonicalBytes({ v: '1', kind: RECORD_KEYS[kind]!, orderId, attrs: { brand: 'Sample', price: '10.00', note: 'x'.repeat(pad) } } as never);
}

const unreachable: DocFetch = async () => {
  throw new Error('no gateway in this test');
};

describe('documents from the content store on this host', () => {
  it('a claim whose records sit in the file:// store reads as held, with no gateway at all', async () => {
    const dir = storeDir();
    const sim = new Sim();
    const orderId = buildClaim(new Sim(), 'filed', 1).orderId;
    const m = new FakeMirror();
    const hashes: `0x${string}`[] = [];
    const seqs: number[] = [];
    const msgs = [];
    for (let k = 0; k < 6; k++) {
      const bytes = docFor(k, orderId);
      const hash = recordHash(bytes);
      const cid = cidOfHash(hash).toString();
      writeFileSync(join(dir, cid), bytes);
      hashes.push(hash);
      seqs.push(k + 1);
      msgs.push({ seq: k + 1, ts: `1700000000.00000000${k}`, payer: k === 4 ? '0.0.2001' : '0.0.1002', body: encodeRecordMsg({ cid, hash, kind: k as 0, orderId }) });
    }
    m.topics.set(TOPIC, msgs);
    const b = buildClaim(sim, 'filed', 1, { hashes, seqs });
    const store = new Store();
    ingest(store, sim);
    await pollHcs(store, { fetch: m.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_000_100 }, TOPIC);
    // The options the service builds from the deployed environment: a file URL and no gateway.
    const ipfs = ipfsOptionsFromEnv({ IPFS_PIN_API_URL: `file://${dir}` });
    expect(ipfs).toEqual({ localDir: dir });
    const h = harness({ store, now: Number(b.now), docs: { ipfs, fetch: unreachable } });
    const d = await h.svc.claimDetail(b.claimId);
    for (const rec of d.records) expect(rec).toMatchObject({ payerOk: true, hashOk: true, held: true, refsMatch: true });
    expect(d.records[3]!.doc).toMatchObject({ kind: 'ordered' });
    expect(h.svc.health().documents).toMatchObject({ localStore: true, gateway: false, cached: 6 });
  });

  it('a damaged store copy reads as unknown, never as held or failed', async () => {
    const dir = storeDir();
    const bytes = docFor(0, '0x' + '12'.repeat(32));
    const hash = recordHash(bytes);
    const cid = cidOfHash(hash).toString();
    writeFileSync(join(dir, cid), new TextEncoder().encode('not the document'));
    const docs = new DocFetcher({ fetch: unreachable, ipfs: { localDir: dir }, ratePerMin: 100, timeoutMs: 100 });
    expect(await docs.get(cid, hash)).toBeNull();
  });
});

describe('document checks and caps', () => {
  const bytes = docFor(1, '0x' + '34'.repeat(32));
  const hash = recordHash(bytes);
  const cid = cidOfHash(hash).toString();

  it('a CID that carries another hash is rejected without a fetch, and stays rejected', async () => {
    let calls = 0;
    const docs = new DocFetcher({ fetch: async () => (calls++, new Response(bytes.slice())), ipfs: { gatewayUrl: 'http://gw.test' }, ratePerMin: 100, timeoutMs: 100 });
    const other = recordHash(new TextEncoder().encode('another document'));
    expect(await docs.get(cid, other)).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    expect(await docs.get(cid, other)).toMatchObject({ ok: false });
    expect(calls).toBe(0);
    expect(await docs.get(cid, hash)).toMatchObject({ ok: true, canonical: true });
  });

  // Test streams are finite (2 MiB), so a reader without the cap fails these tests instead of
  // reading forever: an endless stream never yields to the timer and runs the host out of memory.
  const LIMIT = 2 * 1024 * 1024;

  it('a body without content-length is cut off at the cap instead of read whole', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    const long: DocFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (pulled >= LIMIT) return c.close();
            pulled += chunk.byteLength;
            c.enqueue(chunk);
          },
        }),
        { status: 200 },
      );
    const endless = long;
    const docs = new DocFetcher({ fetch: endless, ipfs: { gatewayUrl: 'http://gw.test' }, ratePerMin: 100, timeoutMs: 5000 });
    const big = 'bafybeibigsample'; // not a raw SHA-256 CID: only the gateway can answer for it
    expect(await docs.get(big, ('0x' + 'ab'.repeat(32)) as `0x${string}`)).toMatchObject({ ok: false, reason: 'document_too_large' });
    expect(pulled).toBeLessThan(MAX_DOCUMENT_BYTES + 4 * chunk.byteLength);
  });

  it('an announced length over the cap is refused before the body is read', async () => {
    let chunks = 0;
    const announced: DocFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (chunks * 64 * 1024 >= LIMIT) return c.close();
            chunks++;
            c.enqueue(new Uint8Array(64 * 1024));
          },
        }),
        { status: 200, headers: { 'content-length': String(300 * 1024 * 1024) } },
      );
    const docs = new DocFetcher({ fetch: announced, ipfs: { gatewayUrl: 'http://gw.test' }, ratePerMin: 100, timeoutMs: 1000 });
    expect(await docs.get('bafybeigdyrsample', hash)).toMatchObject({ ok: false, reason: 'document_too_large' });
    // Only the chunk a stream queues on its own when it is made; nothing was read from it.
    expect(chunks).toBeLessThanOrEqual(1);
  });

  it('keeps the cache inside its byte budget, dropping the least recently used first', async () => {
    const docsBy = new Map<string, Uint8Array>();
    const keys: { cid: string; hash: `0x${string}` }[] = [];
    for (let i = 0; i < 8; i++) {
      const b = docFor(1, '0x' + i.toString(16).padStart(64, '0'), 2000);
      const h = recordHash(b);
      const c = cidOfHash(h).toString();
      docsBy.set(c, b);
      keys.push({ cid: c, hash: h });
    }
    const gw: DocFetch = async (url) => new Response(docsBy.get(url.split('/ipfs/')[1]!.split('?')[0]!)?.slice() ?? null, { status: 200 });
    const budget = 3 * 2600;
    const docs = new DocFetcher({ fetch: gw, ipfs: { gatewayUrl: 'http://gw.test' }, ratePerMin: 100, timeoutMs: 1000, cacheBytes: budget });
    for (const k of keys.slice(0, 3)) expect(await docs.get(k.cid, k.hash)).toMatchObject({ ok: true });
    await docs.get(keys[0]!.cid, keys[0]!.hash); // touch the first: the second is now the oldest
    for (const k of keys.slice(3)) await docs.get(k.cid, k.hash);
    expect(docs.describe().cachedBytes).toBeLessThanOrEqual(budget);
    expect(docs.peek(keys[1]!.cid, keys[1]!.hash)).toBeUndefined();
    expect(docs.peek(keys[7]!.cid, keys[7]!.hash)).toMatchObject({ ok: true });
  });

  it('a failed fetch is unknown and is not retried until the pause has passed', async () => {
    let calls = 0;
    let now = 1_000_000;
    const failing: DocFetch = async () => (calls++, new Response(null, { status: 504 }));
    const docs = new DocFetcher({ fetch: failing, ipfs: { gatewayUrl: 'http://gw.test' }, ratePerMin: 100, timeoutMs: 100, now: () => now, retryAfterMs: 60_000 });
    expect(await docs.get(cid, hash)).toBeNull();
    expect(docs.peek(cid, hash)).toBeNull();
    expect(await docs.get(cid, hash)).toBeNull();
    expect(calls).toBe(1);
    now += 60_001;
    expect(docs.peek(cid, hash)).toBeUndefined();
    await docs.get(cid, hash);
    expect(calls).toBe(2);
  });

  it('a result code it does not know (such as not_found) reads as unknown, not as failed', async () => {
    const docs = new DocFetcher({
      fetch: async () => {
        throw new IpfsError('not_found' as never, 'gone');
      },
      ipfs: { gatewayUrl: 'http://gw.test' },
      ratePerMin: 100,
      timeoutMs: 100,
    });
    expect(await docs.get(cid, hash)).toBeNull();
  });

  it('with no store and no gateway nothing is fetched and every record is unknown', async () => {
    let calls = 0;
    const docs = new DocFetcher({ fetch: async () => (calls++, new Response(bytes.slice())), ipfs: null, ratePerMin: 100, timeoutMs: 100 });
    expect(await docs.get(cid, hash)).toBeNull();
    expect(calls).toBe(0);
    expect(docs.describe()).toMatchObject({ localStore: false, gateway: false });
  });
});
