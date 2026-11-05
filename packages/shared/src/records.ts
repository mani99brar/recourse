// Order records: six slots committed to one HCS topic and referenced on chain by `RecordRefs`.

import type { Hex } from 'viem';

/** Record kind; the value is the slot index in `RecordRefs`. */
export const RecordKind = {
  Asked: 0,
  Shown: 1,
  Approval: 2,
  Ordered: 3,
  Packed: 4,
  Arrived: 5,
} as const;
export type RecordKind = (typeof RecordKind)[keyof typeof RecordKind];

export const RECORD_KINDS = [0, 1, 2, 3, 4, 5] as const satisfies readonly RecordKind[];

/** Key used in documents and JSON, indexed by kind. */
export const RECORD_KEYS = ['asked', 'shown', 'approval', 'ordered', 'packed', 'arrived'] as const;
export type RecordKey = (typeof RECORD_KEYS)[number];

/** One-letter name, indexed by kind. */
export const RECORD_LETTERS = ['I', 'S', 'A', 'O', 'D', 'R'] as const;
export type RecordLetter = (typeof RECORD_LETTERS)[number];

/** Party whose account pays for the record's HCS message. */
export const RECORD_WRITERS: Record<RecordKey, 'platform' | 'shop'> = {
  asked: 'platform',
  shown: 'platform',
  approval: 'platform',
  ordered: 'platform',
  packed: 'shop',
  arrived: 'platform',
};

export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5;
}

export function recordKeyOf(kind: RecordKind): RecordKey {
  return RECORD_KEYS[kind];
}

export function recordKindOf(key: RecordKey): RecordKind {
  return RECORD_KEYS.indexOf(key) as RecordKind;
}

/** Attributes the fault rule compares, in their fixed order. */
export const ATTRIBUTES = ['brand', 'size', 'colour', 'quantity', 'price', 'merchant'] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

export function isAttribute(value: unknown): value is Attribute {
  return typeof value === 'string' && (ATTRIBUTES as readonly string[]).includes(value);
}

export type ApprovalValue = 'approved' | 'not_approved';
export type ApprovalBasis = 'buyer' | 'mandate';

/**
 * On-chain pointer to the six records: the HCS topic number (the N of 0.0.N), the sequence number
 * of each record's message and the SHA-256 of each record document. A zero hash means the record
 * is missing; its seq is then 0.
 */
export interface RecordRefs {
  topicNum: bigint;
  seq: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  hashes: readonly [Hex, Hex, Hex, Hex, Hex, Hex];
}

export const ZERO_HASH: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

export function emptyRecordRefs(topicNum: bigint): RecordRefs {
  return {
    topicNum,
    seq: [0n, 0n, 0n, 0n, 0n, 0n],
    hashes: [ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH],
  };
}
