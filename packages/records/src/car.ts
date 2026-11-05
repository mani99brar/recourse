// Content addressing for record documents. A document is stored as one `raw` block, CIDv1 with a
// SHA-256 multihash, so its CID carries the record hash itself: the CID is known before upload,
// and the CID of a document can be computed from its hash alone.

import * as CarBufferWriter from '@ipld/car/buffer-writer';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';
import type { Hex } from 'viem';
import { hexToBytes, isHex32, recordHash } from '@recourse/shared';

/** Multicodec code of SHA2-256. */
const SHA2_256 = 0x12;

/** CIDv1 (raw codec, SHA2-256) of the document whose recordHash is `hash`. Pure. */
export function cidOfHash(hash: Hex): CID {
  if (!isHex32(hash)) throw new RangeError('cidOfHash: hash must be 0x + 64 lowercase hex');
  return CID.create(1, raw.code, createDigest(SHA2_256, hexToBytes(hash)));
}

/** The record hash a raw SHA2-256 CID carries, or null for any other kind of CID. */
export function hashOfCid(cid: string | CID): Hex | null {
  let parsed: CID;
  try {
    parsed = typeof cid === 'string' ? CID.parse(cid) : cid;
  } catch {
    return null;
  }
  if (parsed.version !== 1 || parsed.code !== raw.code || parsed.multihash.code !== SHA2_256) return null;
  let hex = '0x';
  for (const b of parsed.multihash.digest) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

/** One-block CAR of the document bytes, rooted at the document's CID. */
export function packCar(bytes: Uint8Array): { car: Uint8Array; rootCid: CID; hash: Hex } {
  const hash = recordHash(bytes);
  const rootCid = cidOfHash(hash);
  const block = { cid: rootCid, bytes };
  const size = CarBufferWriter.headerLength({ roots: [rootCid] }) + CarBufferWriter.blockLength(block);
  const writer = CarBufferWriter.createWriter(new ArrayBuffer(size), { roots: [rootCid] });
  writer.write(block);
  return { car: writer.close(), rootCid, hash };
}
