// Raw-block content ids. A record document is stored as one IPFS `raw` block: CIDv1, codec raw
// (0x55), multihash sha2-256, written base32 lower-case with the `b` prefix. Its CID is therefore
// fixed by its SHA-256 alone, and a record message's cid can be checked against its hash without
// fetching anything. Pure, with no multiformats dependency, so the browser bundle can use it.

import { hexToBytes, type Hex } from 'viem';
import { isHex32 } from './hashing.js';

const RAW_CODEC = 0x55;
const SHA2_256 = 0x12;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32lower(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1 string (raw codec, sha2-256, base32 with the `b` prefix) of the raw block whose SHA-256 is `hash`. */
export function rawCidOfHash(hash: Hex): string {
  if (!isHex32(hash)) throw new RangeError('rawCidOfHash: hash must be 0x + 64 lowercase hex');
  const cid = new Uint8Array(4 + 32);
  cid.set([0x01, RAW_CODEC, SHA2_256, 0x20], 0);
  cid.set(hexToBytes(hash), 4);
  return `b${base32lower(cid)}`;
}
