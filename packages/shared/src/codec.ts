// Bridge messages between Hedera and Arbitrum. Each message is `abi.encode` of all-static fields,
// so every field takes one 32-byte word at a fixed offset. Decoders never throw.

import {
  bytesToHex,
  concatHex,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { DecodeStatus, isAnswer, isGap, type Answer, type Gap, type Ruling } from './codes.js';
import type { RecordRefs } from './records.js';

export const CODEC_VERSION = 1;
export const CLAIM_TO_COURT_LEN = 736;
export const RULING_BACK_LEN = 160;

/** Hedera -> Arbitrum: a contested claim going to court. */
export interface ClaimToCourt {
  version: number;
  claimId: Hex;
  platform: Address;
  shop: Address;
  gap: Gap;
  answer: Answer;
  refs: RecordRefs;
  packHash: Hex;
  basketUsdc: bigint;
  netLossUsdc: bigint;
  filedAt: bigint;
}

/** Arbitrum -> Hedera: the final ruling. */
export interface RulingBack {
  version: number;
  claimId: Hex;
  disputeId: bigint;
  ruling: Ruling;
  attempts: number;
}

export type Decoded<T> = { status: typeof DecodeStatus.Ok; value: T } | { status: Exclude<DecodeStatus, 0> };

/** Word index of each ClaimToCourt field (byte offset = 32 * index). */
export const CLAIM_TO_COURT_WORDS = {
  version: 0,
  claimId: 1,
  platform: 2,
  shop: 3,
  gap: 4,
  answer: 5,
  topicNum: 6,
  seq: 7, // 7..12
  hashes: 13, // 13..18
  packHash: 19,
  basketUsdc: 20,
  netLossUsdc: 21,
  filedAt: 22,
} as const;

/** Word index of each RulingBack field. */
export const RULING_BACK_WORDS = { version: 0, claimId: 1, disputeId: 2, ruling: 3, attempts: 4 } as const;

const U64_MAX = (1n << 64n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

function checkU64(v: bigint, name: string): void {
  if (v < 0n || v > U64_MAX) throw new RangeError(`${name} out of uint64 range`);
}
function checkU256(v: bigint, name: string): void {
  if (v < 0n || v > U256_MAX) throw new RangeError(`${name} out of uint256 range`);
}

/** Bytes of a ClaimToCourt message. Throws on an out-of-range code or field (sender side only). */
export function encodeClaimToCourt(m: ClaimToCourt): Hex {
  if (m.version !== CODEC_VERSION) throw new RangeError('encodeClaimToCourt: version must be 1');
  if (!isGap(m.gap)) throw new RangeError('encodeClaimToCourt: bad gap');
  if (!isAnswer(m.answer)) throw new RangeError('encodeClaimToCourt: bad answer');
  checkU64(m.refs.topicNum, 'refs.topicNum');
  m.refs.seq.forEach((s, i) => checkU64(s, `refs.seq[${i}]`));
  checkU256(m.basketUsdc, 'basketUsdc');
  checkU256(m.netLossUsdc, 'netLossUsdc');
  checkU64(m.filedAt, 'filedAt');
  return encodeAbiParameters(
    [
      { type: 'uint8' },
      { type: 'bytes32' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint8' },
      { type: 'uint8' },
      {
        type: 'tuple',
        components: [
          { name: 'topicNum', type: 'uint64' },
          { name: 'seq', type: 'uint64[6]' },
          { name: 'hashes', type: 'bytes32[6]' },
        ],
      },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint64' },
    ],
    [
      m.version,
      m.claimId,
      m.platform,
      m.shop,
      m.gap,
      m.answer,
      { topicNum: m.refs.topicNum, seq: [...m.refs.seq], hashes: [...m.refs.hashes] },
      m.packHash,
      m.basketUsdc,
      m.netLossUsdc,
      m.filedAt,
    ],
  );
}

/** Bytes of a RulingBack message. Throws on an out-of-range code (sender side only). */
export function encodeRulingBack(m: RulingBack): Hex {
  if (m.version !== CODEC_VERSION) throw new RangeError('encodeRulingBack: version must be 1');
  if (!isAnswer(m.ruling)) throw new RangeError('encodeRulingBack: bad ruling');
  if (m.attempts !== 1 && m.attempts !== 2) throw new RangeError('encodeRulingBack: attempts must be 1 or 2');
  checkU256(m.disputeId, 'disputeId');
  return encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint8' }],
    [m.version, m.claimId, m.disputeId, m.ruling, m.attempts],
  );
}

function toBytes(data: Hex | Uint8Array): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return undefined;
  return hexToBytes(data);
}

function word(b: Uint8Array, i: number): Uint8Array {
  return b.subarray(i * 32, i * 32 + 32);
}

/** True when the word fits in `bits` bits (all higher bytes zero). */
function clean(w: Uint8Array, bits: number): boolean {
  const zeroBytes = 32 - bits / 8;
  for (let j = 0; j < zeroBytes; j++) if (w[j] !== 0) return false;
  return true;
}

function uint(w: Uint8Array): bigint {
  return BigInt(bytesToHex(w));
}

/** Decodes a ClaimToCourt message; never throws. Checks run in order: length, dirty words, version, codes. */
export function tryDecodeClaimToCourt(data: Hex | Uint8Array): Decoded<ClaimToCourt> {
  const b = toBytes(data);
  if (b === undefined || b.length !== CLAIM_TO_COURT_LEN) return { status: DecodeStatus.BadLength };
  const W = CLAIM_TO_COURT_WORDS;
  const u8 = [W.version, W.gap, W.answer];
  const u64 = [W.topicNum, W.seq, W.seq + 1, W.seq + 2, W.seq + 3, W.seq + 4, W.seq + 5, W.filedAt];
  const addr = [W.platform, W.shop];
  if (!u8.every((i) => clean(word(b, i), 8))) return { status: DecodeStatus.DirtyWord };
  if (!u64.every((i) => clean(word(b, i), 64))) return { status: DecodeStatus.DirtyWord };
  if (!addr.every((i) => clean(word(b, i), 160))) return { status: DecodeStatus.DirtyWord };
  const version = Number(uint(word(b, W.version)));
  if (version !== CODEC_VERSION) return { status: DecodeStatus.BadVersion };
  const gap = Number(uint(word(b, W.gap)));
  const answer = Number(uint(word(b, W.answer)));
  if (!isGap(gap) || !isAnswer(answer)) return { status: DecodeStatus.BadCode };
  const seq = [0, 1, 2, 3, 4, 5].map((k) => uint(word(b, W.seq + k))) as unknown as RecordRefs['seq'];
  const hashes = [0, 1, 2, 3, 4, 5].map((k) => bytesToHex(word(b, W.hashes + k))) as unknown as RecordRefs['hashes'];
  return {
    status: DecodeStatus.Ok,
    value: {
      version,
      claimId: bytesToHex(word(b, W.claimId)),
      platform: getAddress(bytesToHex(word(b, W.platform).subarray(12))),
      shop: getAddress(bytesToHex(word(b, W.shop).subarray(12))),
      gap,
      answer,
      refs: { topicNum: uint(word(b, W.topicNum)), seq, hashes },
      packHash: bytesToHex(word(b, W.packHash)),
      basketUsdc: uint(word(b, W.basketUsdc)),
      netLossUsdc: uint(word(b, W.netLossUsdc)),
      filedAt: uint(word(b, W.filedAt)),
    },
  };
}

/** Decodes a RulingBack message; never throws. */
export function tryDecodeRulingBack(data: Hex | Uint8Array): Decoded<RulingBack> {
  const b = toBytes(data);
  if (b === undefined || b.length !== RULING_BACK_LEN) return { status: DecodeStatus.BadLength };
  const W = RULING_BACK_WORDS;
  if (![W.version, W.ruling, W.attempts].every((i) => clean(word(b, i), 8))) return { status: DecodeStatus.DirtyWord };
  const version = Number(uint(word(b, W.version)));
  if (version !== CODEC_VERSION) return { status: DecodeStatus.BadVersion };
  const ruling = Number(uint(word(b, W.ruling)));
  const attempts = Number(uint(word(b, W.attempts)));
  if (!isAnswer(ruling) || (attempts !== 1 && attempts !== 2)) return { status: DecodeStatus.BadCode };
  return {
    status: DecodeStatus.Ok,
    value: { version, claimId: bytesToHex(word(b, W.claimId)), disputeId: uint(word(b, W.disputeId)), ruling, attempts },
  };
}

/** keccak256 of the payload bytes, as stored by the Arbitrum receiver. */
export function payloadHash(payload: Hex): Hex {
  return keccak256(payload);
}

/** CCIP `Client.GenericExtraArgsV2` tag. */
export const GENERIC_EXTRA_ARGS_V2_TAG: Hex = '0x181dcf10';

/** Extra args bytes as `Client._argsToBytes(GenericExtraArgsV2{gasLimit, allowOutOfOrderExecution: true})`. */
export function extraArgsFor(gasLimit: bigint | number): Hex {
  const g = BigInt(gasLimit);
  if (g <= 0n) throw new RangeError('extraArgsFor: gasLimit must be positive');
  return concatHex([GENERIC_EXTRA_ARGS_V2_TAG, encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [g, true])]);
}
