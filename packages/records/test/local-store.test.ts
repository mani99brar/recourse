import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as CarBufferWriter from '@ipld/car/buffer-writer';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalBytes, recordHash } from '@recourse/shared';
import { cidOfHash, packCar } from '../src/car.js';
import {
  DEFAULT_LOCAL_STORE_DIR,
  FilebasePinProvider,
  LocalPinProvider,
  fetchDocument,
  ipfsOptionsFromEnv,
  localStoreDirFromEnv,
  openPinClient,
  pinDocument,
  pinProviderFromEnv,
} from '../src/ipfs.js';
import { MemoryIpfs } from '../src/testing.js';

/** A small distinct document per n. */
function doc(n: number): Uint8Array {
  return canonicalBytes({ v: '1', kind: 'asked', note: `document ${n}` });
}

const dirs: string[] = [];
function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recourse-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

describe('local content store', () => {
  it('stores the raw block under its CID and reads it back with no gateway', async () => {
    const dir = storeDir();
    const bytes = doc(1);
    const pinned = await pinDocument(bytes, new LocalPinProvider(dir), { localDir: dir });
    expect(pinned).toEqual({ cid: cidOfHash(recordHash(bytes)).toString(), hash: recordHash(bytes) });
    expect(readdirSync(dir)).toEqual([pinned.cid]);
    expect(same(readFileSync(join(dir, pinned.cid)), bytes)).toBe(true);
    expect(same(await fetchDocument(pinned.cid, pinned.hash, { localDir: dir }), bytes)).toBe(true);
  });

  it('gives the CID a remote pin of the same bytes gives', async () => {
    const bytes = doc(2);
    const local = await pinDocument(bytes, new LocalPinProvider(storeDir()), {});
    const ipfs = new MemoryIpfs();
    const remote = await pinDocument(bytes, ipfs.provider, ipfs.options());
    expect(local).toEqual(remote);
  });

  it('writes a document once, however often and however concurrently it is pinned', async () => {
    const dir = storeDir();
    const provider = new LocalPinProvider(dir);
    const results = await Promise.all(Array.from({ length: 6 }, () => pinDocument(doc(3), provider, {})));
    expect(new Set(results.map((r) => r.cid)).size).toBe(1);
    expect(readdirSync(dir)).toEqual([results[0]!.cid]);
  });

  it('reports a damaged copy instead of serving it, and a new pin repairs it', async () => {
    const dir = storeDir();
    const bytes = doc(4);
    const provider = new LocalPinProvider(dir);
    const { cid, hash } = await pinDocument(bytes, provider, {});
    writeFileSync(join(dir, cid), '{"v":"2"}');
    await expect(fetchDocument(cid, hash, { localDir: dir })).rejects.toMatchObject({ code: 'fetch_failed', message: /damaged/ });
    await pinDocument(bytes, provider, {});
    expect(same(await fetchDocument(cid, hash, { localDir: dir }), bytes)).toBe(true);
  });

  it('refuses a CAR whose block does not hash to the CID it names, and writes nothing', async () => {
    const dir = storeDir();
    const named = packCar(doc(5)).rootCid;
    const block = { cid: named, bytes: doc(6) };
    const size = CarBufferWriter.headerLength({ roots: [named] }) + CarBufferWriter.blockLength(block);
    const writer = CarBufferWriter.createWriter(new ArrayBuffer(size), { roots: [named] });
    writer.write(block);
    await expect(new LocalPinProvider(dir).pinCar(writer.close(), named.toString())).rejects.toMatchObject({ code: 'pin_mismatch' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reads the store first and the gateway only for what the store lacks', async () => {
    const dir = storeDir();
    const ipfs = new MemoryIpfs();
    const stored = await pinDocument(doc(7), new LocalPinProvider(dir), {});
    const elsewhere = packCar(doc(8));
    ipfs.put(elsewhere.rootCid.toString(), doc(8));
    const options = ipfs.options({ localDir: dir });
    expect(same(await fetchDocument(stored.cid, stored.hash, options), doc(7))).toBe(true);
    expect(ipfs.gatewayCalls).toBe(0);
    expect(same(await fetchDocument(elsewhere.rootCid.toString(), elsewhere.hash, options), doc(8))).toBe(true);
    expect(ipfs.gatewayCalls).toBe(1);
    await expect(fetchDocument(packCar(doc(9)).rootCid.toString(), packCar(doc(9)).hash, { localDir: dir })).rejects.toMatchObject({
      code: 'not_found',
      message: /not in the local store/,
    });
  });

  it('never turns a caller string into a path', async () => {
    const dir = storeDir();
    writeFileSync(join(dir, 'secret'), 'x');
    const hash = recordHash(doc(0));
    for (const cid of ['../secret', 'secret', `${dir}/secret`, 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi']) {
      await expect(fetchDocument(cid, hash, { localDir: dir })).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(await new LocalPinProvider(dir).readPinned('../secret')).toBeNull();
  });
});

describe('provider selection', () => {
  const filebase = { IPFS_PIN_API_KEY: 'k', IPFS_PIN_API_SECRET: 's', IPFS_PIN_BUCKET: 'b' };

  it('uses the local store for a file URL, and the default store for one with no directory', () => {
    const provider = pinProviderFromEnv({ IPFS_PIN_API_URL: 'file:///srv/docs/' });
    expect(provider).toBeInstanceOf(LocalPinProvider);
    expect((provider as LocalPinProvider).dir).toBe('/srv/docs');
    expect(localStoreDirFromEnv({ IPFS_PIN_API_URL: 'file://' })).toBe(DEFAULT_LOCAL_STORE_DIR);
    expect(localStoreDirFromEnv({ IPFS_PIN_API_URL: 'file:///' })).toBe(DEFAULT_LOCAL_STORE_DIR);
    expect(localStoreDirFromEnv({ IPFS_PIN_API_URL: 'https://s3.example' })).toBeNull();
    expect(() => localStoreDirFromEnv({ IPFS_PIN_API_URL: 'file://elsewhere/docs' })).toThrowError(/pin_not_configured/);
  });

  it('keeps Filebase whenever the key, secret and bucket are set', () => {
    const withFile = pinProviderFromEnv({ ...filebase, IPFS_PIN_API_URL: 'file:///srv/docs' });
    expect(withFile).toBeInstanceOf(FilebasePinProvider);
    expect((withFile as FilebasePinProvider).endpoint).toBe('https://s3.filebase.com');
    expect((pinProviderFromEnv({ ...filebase, IPFS_PIN_API_URL: 'https://s3.example' }) as FilebasePinProvider).endpoint).toBe('https://s3.example');
    expect(() => pinProviderFromEnv({ ...filebase, IPFS_PIN_API_URL: 'ftp://x' })).toThrowError(/pin_not_configured/);
    // Part of the Filebase set plus a file URL: the local store.
    expect(pinProviderFromEnv({ IPFS_PIN_API_KEY: 'k', IPFS_PIN_API_URL: 'file:///srv/docs' })).toBeInstanceOf(LocalPinProvider);
  });

  it('names both ways to configure pinning when neither is set', () => {
    expect(() => pinProviderFromEnv({})).toThrowError(/pin_not_configured: IPFS_PIN_API_KEY is not set.*IPFS_PIN_API_URL=file:/);
  });

  it('reads the store before the gateway, and needs no gateway with a store', () => {
    expect(ipfsOptionsFromEnv({ IPFS_PIN_API_URL: 'file:///srv/docs' })).toEqual({ localDir: '/srv/docs' });
    expect(ipfsOptionsFromEnv({ IPFS_PIN_API_URL: 'file:///srv/docs', IPFS_GATEWAY_URL: 'https://gw.example' })).toEqual({
      localDir: '/srv/docs',
      gatewayUrl: 'https://gw.example',
    });
    expect(ipfsOptionsFromEnv({ ...filebase, IPFS_GATEWAY_URL: 'https://gw.example' })).toEqual({ gatewayUrl: 'https://gw.example' });
  });
});

describe('openPinClient', () => {
  it('pins and fetches through the store a file URL names', async () => {
    const dir = storeDir();
    const pins = openPinClient({ IPFS_PIN_API_URL: pathToFileURL(dir).href });
    expect(pins.provider.name).toBe('local');
    expect(pins.localDir).toBe(dir);
    const bytes = doc(10);
    const { cid, hash } = await pins.pin(bytes);
    expect(same(await pins.fetch(cid), bytes)).toBe(true);
    expect(same(await pins.fetch(cid, hash), bytes)).toBe(true);
    await expect(pins.fetch(cid, recordHash(doc(11)))).rejects.toMatchObject({ code: 'hash_mismatch' });
    await expect(pins.fetch('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('fails at once when pinning is not configured', () => {
    expect(() => openPinClient({ IPFS_GATEWAY_URL: 'https://gw.example' })).toThrowError(/pin_not_configured/);
  });
});
