// Content ids for the documents this package publishes (policy, trial-case records). Each document is
// one raw IPFS block: CIDv1, codec raw (0x55), multihash sha2-256. Its CID is fixed by its bytes, so it
// is known before anything is pinned, and its multihash is the document's SHA-256.

import { hexToBytes, sha256, type Hex } from 'viem';

const RAW_CODEC = 0x55;
const SHA2_256 = 0x12;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32lower(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Binary CID (version, codec, multihash) of a raw block with this SHA-256. */
export function rawCidBytesOfHash(hash: Hex): Uint8Array {
  const digest = hexToBytes(hash);
  if (digest.length !== 32) throw new RangeError('rawCidBytesOfHash: expected a 32-byte SHA-256');
  const out = new Uint8Array(4 + 32);
  out.set([0x01, RAW_CODEC, SHA2_256, 0x20], 0);
  out.set(digest, 4);
  return out;
}

/** CIDv1 string (base32, `b` prefix) of the raw block whose SHA-256 is `hash`. */
export function rawCidOfHash(hash: Hex): string {
  return 'b' + base32lower(rawCidBytesOfHash(hash));
}

/** CIDv1 string of `bytes` as one raw block. */
export function rawCidOf(bytes: Uint8Array): string {
  return rawCidOfHash(sha256(bytes));
}

/** `/ipfs/<cid>` path of `bytes` as one raw block. */
export function ipfsPathOf(bytes: Uint8Array): string {
  return `/ipfs/${rawCidOf(bytes)}`;
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/**
 * CARv1 holding `bytes` as its one raw block, with that block as the root. Uploading this CAR to a
 * pinning service pins exactly the CID `rawCidOf(bytes)`, whatever chunking the service would use.
 */
export function carOf(bytes: Uint8Array): Uint8Array {
  const cid = rawCidBytesOfHash(sha256(bytes));
  // DAG-CBOR header {"roots": [CID], "version": 1}; keys in DAG-CBOR order (shorter first).
  const cidTagged = [0xd8, 0x2a, 0x58, cid.length + 1, 0x00, ...cid];
  const header = [
    0xa2,
    0x65, ...new TextEncoder().encode('roots'),
    0x81, ...cidTagged,
    0x67, ...new TextEncoder().encode('version'),
    0x01,
  ];
  const parts = [...varint(header.length), ...header, ...varint(cid.length + bytes.length), ...cid];
  const out = new Uint8Array(parts.length + bytes.length);
  out.set(parts, 0);
  out.set(bytes, parts.length);
  return out;
}
