// Document hashing. Documents (record docs, HCS message bodies, pre-check results) are canonical
// JSON and are hashed with SHA-256 over their exact bytes. Ids use keccak256 instead (ids.ts).
//
// Canonical form: RFC 8785 restricted to objects, arrays, strings and booleans. UTF-8, no BOM, no
// whitespace, object keys sorted by UTF-16 code units, strings escaped as RFC 8785 (the same as
// ECMAScript JSON.stringify), no trailing newline. Numbers and null are not allowed; integers and
// amounts are decimal strings and absent fields are omitted.

import { bytesToHex, sha256, type Hex } from 'viem';

export type CanonicalValue = string | boolean | CanonicalValue[] | { [key: string]: CanonicalValue | undefined };

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serialiseString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new CanonicalError('canonicalJson: string holds a lone surrogate');
  return JSON.stringify(s);
}

function serialise(value: unknown, path: string): string {
  if (typeof value === 'string') return serialiseString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) throw new CanonicalError(`canonicalJson: null at ${path}`);
  if (typeof value === 'number' || typeof value === 'bigint') {
    throw new CanonicalError(`canonicalJson: number at ${path}; use a decimal string`);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, i) => {
        if (item === undefined) throw new CanonicalError(`canonicalJson: undefined at ${path}[${i}]`);
        return serialise(item, `${path}[${i}]`);
      })
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalError(`canonicalJson: unsupported object at ${path}`);
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    // Default sort compares UTF-16 code units, which is what RFC 8785 asks for.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${serialiseString(k)}:${serialise(v, `${path}.${k}`)}`).join(',')}}`;
  }
  throw new CanonicalError(`canonicalJson: unsupported ${typeof value} at ${path}`);
}

/** Canonical JSON text of a value. Throws CanonicalError on numbers, null or other non-JSON values. */
export function canonicalJson(value: CanonicalValue): string {
  return serialise(value, '$');
}

/** UTF-8 bytes of `canonicalJson(value)`. */
export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/** Parses bytes that must already be canonical; anything else (BOM, whitespace, numbers, bad UTF-8) is not ok. */
export function parseCanonical(bytes: Uint8Array): { ok: true; value: CanonicalValue } | { ok: false } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  let again: string;
  try {
    again = serialise(parsed, '$');
  } catch {
    return { ok: false };
  }
  return again === text ? { ok: true, value: parsed as CanonicalValue } : { ok: false };
}

/** True only when the bytes are the canonical form of the JSON they hold. */
export function isCanonical(bytes: Uint8Array): boolean {
  return parseCanonical(bytes).ok;
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/** `0x` + 64 lowercase hex digits. */
export function isHex32(value: unknown): value is Hex {
  return typeof value === 'string' && HEX32.test(value);
}

/** 32 bytes as `0x` + 64 lowercase hex. */
export function hex32(bytes: Uint8Array): Hex {
  if (bytes.length !== 32) throw new RangeError('hex32: expected 32 bytes');
  return bytesToHex(bytes);
}

/** SHA-256 of the exact document bytes (as pinned to IPFS and as fetched back). Never re-serialise first. */
export function recordHash(bytes: Uint8Array): Hex {
  return sha256(bytes);
}

/** SHA-256 of the canonical pre-check result document bytes. */
export function packHash(bytes: Uint8Array): Hex {
  return recordHash(bytes);
}

function saltBytes(salt: Hex | Uint8Array): Uint8Array {
  if (typeof salt !== 'string') {
    if (salt.length !== 32) throw new RangeError('saltedField: salt must be 32 bytes');
    return salt;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new RangeError('saltedField: salt must be 32 bytes');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(salt.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** SHA-256(32 salt bytes ‖ UTF-8 value bytes), for buyer fields kept out of public records. */
export function saltedField(value: string, salt: Hex | Uint8Array): Hex {
  const s = saltBytes(salt);
  const v = new TextEncoder().encode(value);
  const buf = new Uint8Array(32 + v.length);
  buf.set(s, 0);
  buf.set(v, 32);
  return sha256(buf);
}
