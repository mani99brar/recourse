import { describe, expect, it } from 'vitest';
import { hexToBytes, type Hex } from 'viem';
import {
  CanonicalError,
  canonicalBytes,
  canonicalJson,
  decodeRecordMsg,
  encodeRecordMsg,
  hex32,
  isCanonical,
  packHash,
  recordHash,
  saltedField,
  utf8ToBytes,
} from '../src/index.js';
import { vector } from './vectors.js';

// Digests in hashing.json were computed with sha256sum over the exact text bytes.
const v = vector('hashing.json');

describe('canonical form', () => {
  it.each(v.canonical.map((c: any) => [c.name, c] as const))('%s', (_n, c: any) => {
    expect(canonicalJson(c.value)).toBe(c.text);
    const bytes = canonicalBytes(c.value);
    expect(isCanonical(bytes)).toBe(true);
    expect(recordHash(bytes)).toBe(c.sha256);
    expect(packHash(bytes)).toBe(c.sha256);
  });

  it.each(v.nonCanonical.map((c: any) => [c.name, c.hex] as const))('rejects %s', (_n, hex) => {
    expect(isCanonical(hexToBytes(`0x${hex}` as Hex))).toBe(false);
  });

  it('refuses numbers, null and lone surrogates when serialising', () => {
    expect(() => canonicalJson({ a: 1 } as never)).toThrow(CanonicalError);
    expect(() => canonicalJson({ a: null } as never)).toThrow(CanonicalError);
    expect(() => canonicalJson(['\ud800'])).toThrow(CanonicalError);
    expect(canonicalJson({ b: undefined, a: 'x' })).toBe('{"a":"x"}');
  });
});

describe('HCS record message', () => {
  const m = v.recordMsg;
  it('encodes the vector body and decodes it back', () => {
    const bytes = encodeRecordMsg(m.fields);
    expect(new TextDecoder().decode(bytes)).toBe(m.text);
    expect(recordHash(bytes)).toBe(m.sha256);
    expect(decodeRecordMsg(bytes)).toEqual({ ok: true, value: m.fields });
  });

  const body = (o: Record<string, unknown>) => utf8ToBytes(JSON.stringify(Object.fromEntries(Object.entries(o).sort())));
  const good = { cid: m.fields.cid, hash: m.fields.hash, kind: '0', orderId: m.fields.orderId, v: '1' };
  it.each([
    ['missing field', { ...good, cid: undefined }],
    ['extra field', { ...good, x: '1' }],
    ['kind 6', { ...good, kind: '6' }],
    ['kind as a number', { ...good, kind: 0 }],
    ['version 2', { ...good, v: '2' }],
    ['upper-case hash', { ...good, hash: m.fields.hash.toUpperCase().replace('0X', '0x') }],
    ['short order id', { ...good, orderId: '0x12' }],
    ['empty cid', { ...good, cid: '' }],
    ['over 1,024 bytes', { ...good, cid: 'b'.repeat(1000) }],
  ])('rejects %s', (_n, o) => {
    expect(decodeRecordMsg(body(o as Record<string, unknown>)).ok).toBe(false);
  });

  it('rejects non-canonical bytes and refuses to encode bad fields', () => {
    expect(decodeRecordMsg(utf8ToBytes(m.text.replace(',', ', '))).ok).toBe(false);
    expect(() => encodeRecordMsg({ ...m.fields, kind: 6 })).toThrow();
    expect(() => encodeRecordMsg({ ...m.fields, cid: 'b'.repeat(1000) })).toThrow();
  });
});

describe('saltedField and hex32', () => {
  it('matches the vector', () => {
    const s = v.saltedField;
    expect(saltedField(s.value, s.salt)).toBe(s.expected);
    expect(saltedField(s.value, hexToBytes(s.salt))).toBe(s.expected);
    expect(() => saltedField(s.value, '0x01')).toThrow();
  });
  it('hex32 is lowercase and exactly 32 bytes', () => {
    expect(hex32(new Uint8Array(32).fill(0xab))).toBe(`0x${'ab'.repeat(32)}`);
    expect(() => hex32(new Uint8Array(31))).toThrow();
  });
});
