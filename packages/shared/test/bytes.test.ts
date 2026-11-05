import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, sha256, utf8ToBytes } from '../src/index.js';

describe('byte helpers', () => {
  it('hashes with SHA-256', () => {
    expect(sha256(utf8ToBytes('abc'))).toBe('0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(new Uint8Array())).toBe('0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('round-trips hex and UTF-8', () => {
    expect(bytesToHex(utf8ToBytes('é'))).toBe('0xc3a9');
    expect(hexToBytes('0xc3a9')).toEqual(new Uint8Array([0xc3, 0xa9]));
    expect(() => hexToBytes('0xabc' as `0x${string}`)).toThrow();
  });
});
