import { describe, expect, it } from 'vitest';
import { concatHex, keccak256, type Hex } from 'viem';
import {
  CLAIM_TO_COURT_LEN,
  DecodeStatus,
  RULING_BACK_LEN,
  encodeClaimToCourt,
  encodeRulingBack,
  extraArgsFor,
  payloadHash,
  tryDecodeClaimToCourt,
  tryDecodeRulingBack,
  type ClaimToCourt,
  type RulingBack,
} from '../src/index.js';
import { vector } from './vectors.js';

// Encoded bytes in codec.json were produced with `cast abi-encode` on the field signature.
const v = vector('codec.json');

function claimFrom(j: any): ClaimToCourt {
  return {
    ...j,
    refs: { topicNum: BigInt(j.refs.topicNum), seq: j.refs.seq.map(BigInt), hashes: j.refs.hashes },
    basketUsdc: BigInt(j.basketUsdc),
    netLossUsdc: BigInt(j.netLossUsdc),
    filedAt: BigInt(j.filedAt),
  };
}
const rulingFrom = (j: any): RulingBack => ({ ...j, disputeId: BigInt(j.disputeId) });

function setWordByte(hex: Hex, word: number, byte: number, value: number): Hex {
  const at = 2 + (word * 32 + byte) * 2;
  return (hex.slice(0, at) + value.toString(16).padStart(2, '0') + hex.slice(at + 2)) as Hex;
}

describe('ClaimToCourt', () => {
  it.each((v.claimToCourt as any[]).map((c: any): [string, any] => [c.name, c]))('%s: encodes, decodes, hashes', (_n, c: any) => {
    const m = claimFrom(c.value);
    const enc = encodeClaimToCourt(m);
    expect(enc).toBe(c.encoded);
    expect((enc.length - 2) / 2).toBe(CLAIM_TO_COURT_LEN);
    expect(payloadHash(enc)).toBe(c.payloadHash);
    const d = tryDecodeClaimToCourt(enc);
    expect(d.status).toBe(DecodeStatus.Ok);
    if (d.status === DecodeStatus.Ok) expect(d.value).toEqual(m);
  });

  it('reports each decode status in order', () => {
    const good = v.claimToCourt[0].encoded as Hex;
    expect(tryDecodeClaimToCourt(concatHex([good, '0x00'])).status).toBe(DecodeStatus.BadLength);
    expect(tryDecodeClaimToCourt('0x').status).toBe(DecodeStatus.BadLength);
    expect(tryDecodeClaimToCourt('0xzz' as Hex).status).toBe(DecodeStatus.BadLength);
    expect(tryDecodeClaimToCourt(setWordByte(good, 2, 11, 1)).status).toBe(DecodeStatus.DirtyWord); // address
    expect(tryDecodeClaimToCourt(setWordByte(good, 7, 23, 1)).status).toBe(DecodeStatus.DirtyWord); // uint64 seq
    expect(tryDecodeClaimToCourt(setWordByte(good, 4, 30, 1)).status).toBe(DecodeStatus.DirtyWord); // uint8 gap
    expect(tryDecodeClaimToCourt(setWordByte(good, 0, 31, 2)).status).toBe(DecodeStatus.BadVersion);
    expect(tryDecodeClaimToCourt(setWordByte(good, 4, 31, 4)).status).toBe(DecodeStatus.BadCode);
    expect(tryDecodeClaimToCourt(setWordByte(good, 5, 31, 4)).status).toBe(DecodeStatus.BadCode);
    // dirty beats version
    expect(tryDecodeClaimToCourt(setWordByte(setWordByte(good, 0, 31, 2), 3, 0, 1)).status).toBe(DecodeStatus.DirtyWord);
  });

  it('refuses to encode a bad code', () => {
    const m = claimFrom(v.claimToCourt[0].value);
    expect(() => encodeClaimToCourt({ ...m, gap: 4 as never })).toThrow();
    expect(() => encodeClaimToCourt({ ...m, answer: 4 as never })).toThrow();
    expect(() => encodeClaimToCourt({ ...m, version: 2 })).toThrow();
  });
});

describe('RulingBack', () => {
  it.each((v.rulingBack as any[]).map((c: any): [string, any] => [c.name, c]))('%s: encodes and decodes', (_n, c: any) => {
    const m = rulingFrom(c.value);
    const enc = encodeRulingBack(m);
    expect(enc).toBe(c.encoded);
    expect((enc.length - 2) / 2).toBe(RULING_BACK_LEN);
    const d = tryDecodeRulingBack(enc);
    expect(d.status).toBe(DecodeStatus.Ok);
    if (d.status === DecodeStatus.Ok) expect(d.value).toEqual(m);
  });

  it('reports each decode status', () => {
    const good = v.rulingBack[0].encoded as Hex;
    expect(tryDecodeRulingBack(good.slice(0, -2) as Hex).status).toBe(DecodeStatus.BadLength);
    expect(tryDecodeRulingBack(setWordByte(good, 3, 0, 1)).status).toBe(DecodeStatus.DirtyWord);
    expect(tryDecodeRulingBack(setWordByte(good, 0, 31, 0)).status).toBe(DecodeStatus.BadVersion);
    expect(tryDecodeRulingBack(setWordByte(good, 3, 31, 4)).status).toBe(DecodeStatus.BadCode);
    expect(tryDecodeRulingBack(setWordByte(good, 4, 31, 0)).status).toBe(DecodeStatus.BadCode);
    expect(tryDecodeRulingBack(setWordByte(good, 4, 31, 3)).status).toBe(DecodeStatus.BadCode);
  });

  it('refuses to encode bad attempts', () => {
    expect(() => encodeRulingBack({ ...rulingFrom(v.rulingBack[0].value), attempts: 3 })).toThrow();
  });
});

describe('decoders never throw', () => {
  it('on random bytes of every length up to 800', () => {
    let seed = keccak256('0x01');
    for (let len = 0; len <= 800; len++) {
      let hex = '0x';
      while (hex.length < 2 + len * 2) {
        seed = keccak256(seed);
        hex += seed.slice(2);
      }
      const data = hex.slice(0, 2 + len * 2) as Hex;
      expect(() => tryDecodeClaimToCourt(data)).not.toThrow();
      expect(() => tryDecodeRulingBack(data)).not.toThrow();
    }
  });
});

describe('extraArgsFor', () => {
  it.each((v.extraArgs as any[]).map((e: any): [string, string] => [e.gasLimit, e.encoded]))('gas %s', (gas, encoded) => {
    expect(extraArgsFor(BigInt(gas))).toBe(encoded);
  });
});
