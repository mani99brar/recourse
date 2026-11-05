// Byte helpers for packages that depend only on @recourse/shared. Browser-safe and synchronous.

import {
  bytesToHex as viemBytesToHex,
  hexToBytes as viemHexToBytes,
  sha256 as viemSha256,
  stringToBytes,
  type Hex,
} from 'viem';

/** SHA-256 of the bytes, as `0x` + 64 lowercase hex. */
export function sha256(bytes: Uint8Array): Hex {
  return viemSha256(bytes);
}

/** UTF-8 encoding of a string. */
export function utf8ToBytes(text: string): Uint8Array {
  return stringToBytes(text);
}

/** Lowercase `0x` hex of the bytes. */
export function bytesToHex(bytes: Uint8Array): Hex {
  return viemBytesToHex(bytes);
}

/** Bytes of a `0x` hex string; throws on odd length or non-hex characters. */
export function hexToBytes(hex: Hex): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new RangeError('hexToBytes: not 0x-prefixed even-length hex');
  return viemHexToBytes(hex);
}
