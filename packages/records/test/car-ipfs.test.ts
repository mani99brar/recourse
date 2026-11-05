import { CarBufferReader } from '@ipld/car/buffer-reader';
import { describe, expect, it } from 'vitest';
import { canonicalBytes, recordHash, utf8ToBytes } from '@recourse/shared';
import { cidOfHash, hashOfCid, packCar } from '../src/car.js';
import { IpfsError, MAX_DOCUMENT_BYTES, fetchDocument, ipfsOptionsFromEnv, pinDocument, pinProviderFromEnv } from '../src/ipfs.js';
import { MemoryIpfs } from '../src/testing.js';
import { ORDER, doc } from './helpers.js';

// The court policy is stored as one raw block; its published CID and SHA-256 pin the CID derivation.
const POLICY_SHA256 = '0x5efd65be933b514c8a432d240e5e5bbb7a35bc0e1200849d7bab0290d29286ee';
const POLICY_CID = 'bafkreic67vs35ez3kfgiuqzneqhf4w53pi23ydqsaccj265lakinfeug5y';

describe('content addressing', () => {
  it('derives the published CID of a raw block from its SHA-256', () => {
    expect(cidOfHash(POLICY_SHA256).toString()).toBe(POLICY_CID);
    expect(hashOfCid(POLICY_CID)).toBe(POLICY_SHA256);
  });

  it('packs one raw block whose CID carries the record hash', () => {
    const bytes = doc(0);
    const { car, rootCid, hash } = packCar(bytes);
    expect(hash).toBe(recordHash(bytes));
    expect(rootCid.version).toBe(1);
    expect(rootCid.code).toBe(0x55);
    expect(hashOfCid(rootCid)).toBe(hash);
    const reader = CarBufferReader.fromBytes(car);
    expect(reader.getRoots().map(String)).toEqual([rootCid.toString()]);
    const blocks = reader.blocks();
    expect(blocks).toHaveLength(1);
    expect(Buffer.from(blocks[0]!.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it('reads no hash from a CID of another codec or a malformed one', () => {
    expect(hashOfCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBeNull();
    expect(hashOfCid('not-a-cid')).toBeNull();
  });
});

describe('pinning', () => {
  it('pins, reads back and returns the local CID', async () => {
    const ipfs = new MemoryIpfs();
    const bytes = doc(1);
    const pinned = await pinDocument(bytes, ipfs.provider, ipfs.options());
    expect(pinned.cid).toBe(cidOfHash(recordHash(bytes)).toString());
    expect(pinned.hash).toBe(recordHash(bytes));
    expect(ipfs.has(pinned.cid)).toBe(true);
    const back = await fetchDocument(pinned.cid, pinned.hash, ipfs.options());
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
  });

  it('refuses a provider that reports another CID', async () => {
    const ipfs = new MemoryIpfs();
    ipfs.inject('wrong_cid');
    await expect(pinDocument(doc(0), ipfs.provider, ipfs.options())).rejects.toMatchObject({ code: 'pin_mismatch' });
  });

  it('refuses a pin whose bytes come back different', async () => {
    const ipfs = new MemoryIpfs();
    ipfs.inject('corrupt');
    await expect(pinDocument(doc(0), ipfs.provider, ipfs.options())).rejects.toMatchObject({ code: 'pin_mismatch' });
  });

  it('retries a failing provider, then reports pin_failed', async () => {
    const ipfs = new MemoryIpfs();
    ipfs.inject('fail');
    await expect(pinDocument(doc(0), ipfs.provider, ipfs.options({ retries: 1 }))).resolves.toBeTruthy();
    expect(ipfs.pinCalls).toBe(2);
    const failing = new MemoryIpfs();
    failing.inject('fail', 'fail');
    await expect(pinDocument(doc(0), failing.provider, failing.options({ retries: 1 }))).rejects.toMatchObject({ code: 'pin_failed' });
  });

  it('refuses documents over the size limit before uploading', async () => {
    const ipfs = new MemoryIpfs();
    const big = canonicalBytes({ v: '1', pad: 'x'.repeat(MAX_DOCUMENT_BYTES) });
    await expect(pinDocument(big, ipfs.provider, ipfs.options())).rejects.toMatchObject({ code: 'document_too_large' });
    expect(ipfs.pinCalls).toBe(0);
  });

  it('fails clearly when the pin credentials are missing', () => {
    const env = { IPFS_PIN_API_SECRET: 's', IPFS_PIN_BUCKET: 'b' };
    expect(() => pinProviderFromEnv(env)).toThrowError(IpfsError);
    expect(() => pinProviderFromEnv(env)).toThrowError(/pin_not_configured: IPFS_PIN_API_KEY is not set/);
    expect(() => pinProviderFromEnv({ IPFS_PIN_API_KEY: 'k', IPFS_PIN_BUCKET: 'b' })).toThrowError(/IPFS_PIN_API_SECRET/);
    expect(() => ipfsOptionsFromEnv({})).toThrowError(/IPFS_GATEWAY_URL/);
  });
});

describe('fetching', () => {
  it('rejects bytes that do not hash to the expected value', async () => {
    const ipfs = new MemoryIpfs();
    const bytes = doc(0);
    const { rootCid, hash } = packCar(bytes);
    ipfs.put(rootCid.toString(), utf8ToBytes('{"v":"2"}'));
    await expect(fetchDocument(rootCid.toString(), hash, ipfs.options())).rejects.toMatchObject({ code: 'hash_mismatch' });
  });

  it('rejects a CID that carries a different hash without fetching', async () => {
    const ipfs = new MemoryIpfs();
    const { rootCid } = packCar(doc(0));
    await expect(fetchDocument(rootCid.toString(), recordHash(doc(0, ORDER, 1)), ipfs.options())).rejects.toMatchObject({
      code: 'hash_mismatch',
    });
    expect(ipfs.gatewayCalls).toBe(0);
  });

  it('reports fetch_failed for a CID the gateway does not have', async () => {
    const ipfs = new MemoryIpfs();
    const { rootCid, hash } = packCar(doc(0));
    await expect(fetchDocument(rootCid.toString(), hash, ipfs.options())).rejects.toMatchObject({ code: 'fetch_failed' });
  });
});
