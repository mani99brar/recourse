// Closed request bodies: every action lists its fields, anything else is refused before it is read
// (so no key, seed or password can be sent), and every value is checked for shape and range.

import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { V1Error, invalid, missing } from './errors.js';

export type FieldKind = 'address' | 'bytes32' | 'uint' | 'bool' | 'attempt' | 'name' | 'text' | 'fileURI' | 'payIn';

export interface FieldSpec {
  kind: FieldKind;
  required?: boolean;
}

export type BodySpec = Record<string, FieldSpec>;

const UINT = /^(0|[1-9][0-9]*)$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FILE_URI = /^(\/ipfs\/[A-Za-z0-9]+(\/.*)?|https:\/\/.+)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type Parsed = Record<string, Address | Hex | bigint | boolean | number | string | undefined>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

export function parseAddress(field: string, v: unknown): Address {
  if (typeof v !== 'string' || !ADDRESS.test(v) || !isAddress(v, { strict: false })) throw invalid(field, 'expected an address, 0x and 40 hex digits');
  if (v.toLowerCase() === ZERO_ADDRESS) throw invalid(field, 'the zero address is not an account');
  return getAddress(v);
}

export function parseBytes32(field: string, v: unknown): Hex {
  if (typeof v !== 'string' || !BYTES32.test(v)) throw invalid(field, 'expected 32 bytes, 0x and 64 hex digits');
  return v.toLowerCase() as Hex;
}

export function parseUint(field: string, v: unknown): bigint {
  if (typeof v !== 'string' || !UINT.test(v) || v.length > 78) throw invalid(field, 'expected an unsigned integer as a decimal string');
  const n = BigInt(v);
  if (n > MAX_UINT256) throw invalid(field, 'above the largest uint256');
  return n;
}

function parseField(field: string, kind: FieldKind, v: unknown): Parsed[string] {
  switch (kind) {
    case 'address':
      return parseAddress(field, v);
    case 'bytes32':
      return parseBytes32(field, v);
    case 'uint':
      return parseUint(field, v);
    case 'bool':
      if (typeof v !== 'boolean') throw invalid(field, 'expected true or false');
      return v;
    case 'attempt':
      if (v !== 1 && v !== 2) throw invalid(field, 'expected 1 or 2');
      return v;
    case 'name':
      if (typeof v !== 'string' || v.trim() === '') throw invalid(field, 'expected a non-empty string');
      if ([...v].length > 200) throw invalid(field, 'at most 200 characters');
      return v;
    case 'text':
      if (typeof v !== 'string' || v.trim() === '') throw invalid(field, 'expected a non-empty string');
      return v;
    case 'fileURI':
      if (typeof v !== 'string' || v.length > 512 || !FILE_URI.test(v)) throw invalid(field, 'expected /ipfs/<cid> or an https:// link, at most 512 characters');
      return v;
    case 'payIn':
      if (v !== 'native' && v !== 'link') throw invalid(field, "expected 'native' or 'link'");
      return v;
  }
}

/** Checks a request body against its spec: closed, required fields present, each value well formed. */
export function parseBody(raw: unknown, spec: BodySpec): Parsed {
  if (!isPlainObject(raw)) throw new V1Error('bad_json', 'The body must be a JSON object.');
  for (const k of Object.keys(raw)) {
    if (!Object.hasOwn(spec, k)) throw new V1Error('unknown_field', `This action does not take ${k.length > 64 ? 'that field' : k}.`, { field: k.slice(0, 64) });
  }
  const out: Parsed = {};
  for (const [k, s] of Object.entries(spec)) {
    const v = raw[k];
    if (v === undefined || v === null) {
      if (s.required) throw missing(k);
      continue;
    }
    out[k] = parseField(k, s.kind, v);
  }
  return out;
}
