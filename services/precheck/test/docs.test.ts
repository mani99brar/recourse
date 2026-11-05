import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransientError } from '@recourse/keeper';
import { afterEach, describe, expect, it } from 'vitest';
import { openPinClient } from '@recourse/records';
import { GatewayDocStore, LocalDocStore, PinnedDocStore, rawBlockCid } from '../src/docs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gateway(over: Partial<ConstructorParameters<typeof GatewayDocStore>[0]> = {}) {
  const calls: string[] = [];
  let status = 200;
  const store = new GatewayDocStore({
    gatewayUrl: 'https://gateway.example/',
    fetch: async (url) => {
      calls.push(url);
      return status === 200 ? new Response(new Uint8Array([1, 2, 3]).buffer) : new Response('', { status });
    },
    ...over,
  });
  return { store, calls, setStatus: (s: number) => (status = s) };
}

describe('docs', () => {
  it('the raw-block cid has the documented form (the court policy block)', () => {
    const policy = readFileSync(join(import.meta.dirname, '../../../packages/court/policy/policy-v1.md'));
    expect(rawBlockCid(new Uint8Array(policy))).toBe('bafkreiczyufqa6mwis3riitqeiz6cozbk6zpgyx5xy3rpm4usqedje45im');
  });

  it('reads <gateway>/ipfs/<cid>, caches by cid, and re-reads on request', async () => {
    const { store, calls } = gateway();
    expect(await store.fetch('bafyabc')).toEqual(new Uint8Array([1, 2, 3]));
    await store.fetch('bafyabc');
    expect(calls).toEqual(['https://gateway.example/ipfs/bafyabc']);
    await store.fetch('bafyabc', { fresh: true });
    expect(calls).toHaveLength(2);
  });

  it('404 is null; 5xx and 429 are transient; a bad cid never reaches the network', async () => {
    const g = gateway();
    g.setStatus(404);
    expect(await g.store.fetch('bafynone')).toBeNull();
    g.setStatus(503);
    await expect(g.store.fetch('bafy1')).rejects.toBeInstanceOf(TransientError);
    g.setStatus(429);
    await expect(g.store.fetch('bafy2')).rejects.toBeInstanceOf(TransientError);
    const before = g.calls.length;
    expect(await g.store.fetch('../etc/passwd')).toBeNull();
    expect(g.calls).toHaveLength(before);
  });

  it('stays inside the request budget and recovers as the minute rolls over', async () => {
    let now = 0;
    const { store, calls } = gateway({ maxPerMinute: 3, now: () => now });
    for (const c of ['a1', 'a2', 'a3']) await store.fetch(c);
    await expect(store.fetch('a4')).rejects.toBeInstanceOf(TransientError);
    expect(calls).toHaveLength(3);
    now = 61_000;
    await store.fetch('a4');
    expect(calls).toHaveLength(4);
  });

  it('forgets the oldest cached documents past its cap', async () => {
    const { store, calls } = gateway({ cacheEntries: 2 });
    for (const c of ['c1', 'c2', 'c3']) await store.fetch(c);
    await store.fetch('c1');
    expect(calls).toHaveLength(4);
  });

  it('has no pin without a pin client', async () => {
    await expect(gateway().store.pin(new Uint8Array([1]))).rejects.toThrow('no pin client');
  });

  it('the local stand-in pins to files and reads them back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'precheck-localdocs-'));
    dirs.push(dir);
    const local = new LocalDocStore(dir);
    const bytes = new Uint8Array([9, 8, 7]);
    const cid = await local.pin(bytes);
    expect(cid).toBe(rawBlockCid(bytes));
    expect(await local.fetch(cid)).toEqual(bytes);
    expect(await local.pin(bytes)).toBe(cid);
    expect(await local.fetch('bafymissing')).toBeNull();
  });

  it('pins and reads through the shared pin client on a file:// content store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'precheck-pinstore-'));
    dirs.push(dir);
    const pins = openPinClient({ IPFS_PIN_API_URL: `file://${dir}` });
    const store = new PinnedDocStore({ source: { fetch: (cid) => pins.fetch(cid) }, pinClient: { pin: async (b) => (await pins.pin(b)).cid } });
    const bytes = new TextEncoder().encode('{"doc":"result"}');
    const cid = await store.pin(bytes);
    expect(cid).toBe(rawBlockCid(bytes));
    expect(await store.fetch(cid)).toEqual(bytes);
    await expect(store.fetch(rawBlockCid(new Uint8Array([4, 4, 4])))).rejects.toBeInstanceOf(TransientError);
  });
});
