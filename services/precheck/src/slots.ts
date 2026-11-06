// The outcome of proving one record slot, and its JSON form for the journal.

import { bytesToHex, hexToBytes, isHex32, type RecordKind } from '@recourse/shared';
import type { Hex } from 'viem';

export const REASONS = [
  'topic_mismatch',
  'doc_invalid',
  'kind_mismatch',
  'order_mismatch',
  'hash_mismatch_hcs',
  'payer_mismatch',
  'after_filing',
  'bytes_mismatch',
  /** The document is larger than RECORD_DOC_MAX_BYTES (or than the store reads). */
  'doc_too_large',
  /** The document could not be read by the time the wait after the filing was over. */
  'doc_unavailable',
  /** An approval or arrived record whose signature is missing, broken or by a signer the party map does not allow. */
  'signature_invalid',
] as const;
export type Reason = (typeof REASONS)[number];

/** Why the claim's refs were not the record used. `not_named` = the refs held a zero hash for the slot. */
export type RefsReason = Reason | 'not_named';

/** What the claim's refs said about a slot when the record used came from the index instead. */
export interface RefsDisagreement {
  seq: bigint;
  hash: Hex;
  reason: RefsReason;
}

export interface HeldSlot {
  kind: RecordKind;
  outcome: 'held';
  seq: bigint;
  /** SHA-256 named by the HCS message; equals the SHA-256 of `bytes`. */
  hcsHash: Hex;
  cid: string;
  payer: string;
  /** Mirror consensus timestamp of the message, "<s>.<ns>". */
  consensusAt: string;
  /** Exact document bytes. */
  bytes: Uint8Array;
  /** Present when the refs named a record that was not the one used, or named none. */
  refs?: RefsDisagreement;
}

export interface RejectedSlot {
  kind: RecordKind;
  outcome: 'rejected';
  reason: Reason;
  seq?: bigint;
  hcsHash?: Hex;
  cid?: string;
}

export interface AbsentSlot {
  kind: RecordKind;
  outcome: 'absent';
}

export type SlotOutcome = HeldSlot | RejectedSlot | AbsentSlot;

type Json = { [key: string]: string | Json | undefined };

export function slotToJson(s: SlotOutcome): Json {
  if (s.outcome === 'absent') return { kind: String(s.kind), outcome: 'absent' };
  if (s.outcome === 'rejected') {
    return {
      kind: String(s.kind),
      outcome: 'rejected',
      reason: s.reason,
      seq: s.seq?.toString(),
      hcsHash: s.hcsHash,
      cid: s.cid,
    };
  }
  return {
    kind: String(s.kind),
    outcome: 'held',
    seq: s.seq.toString(),
    hcsHash: s.hcsHash,
    cid: s.cid,
    payer: s.payer,
    consensusAt: s.consensusAt,
    bytes: bytesToHex(s.bytes),
    refs: s.refs === undefined ? undefined : { seq: s.refs.seq.toString(), hash: s.refs.hash, reason: s.refs.reason },
  };
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`journal: ${what} is not an object`);
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Error(`journal: slot field ${key} is not a string`);
  return v;
}

function optStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`journal: slot field ${key} is not a string`);
  return v;
}

function hex(o: Record<string, unknown>, key: string): Hex {
  const v = str(o, key);
  if (!isHex32(v)) throw new Error(`journal: slot field ${key} is not a 32-byte hash`);
  return v;
}

function kindOf(o: Record<string, unknown>): RecordKind {
  const k = str(o, 'kind');
  if (!/^[0-5]$/.test(k)) throw new Error('journal: slot kind out of range');
  return Number(k) as RecordKind;
}

function isReason(v: string): v is Reason {
  return (REASONS as readonly string[]).includes(v);
}

/** Reads a slot back from the journal. Throws on any shape problem: the journal is ours, so a bad one is corruption. */
export function slotFromJson(value: unknown): SlotOutcome {
  const o = obj(value, 'slot');
  const kind = kindOf(o);
  const outcome = str(o, 'outcome');
  if (outcome === 'absent') return { kind, outcome };
  if (outcome === 'rejected') {
    const reason = str(o, 'reason');
    if (!isReason(reason)) throw new Error('journal: unknown slot reason');
    const out: RejectedSlot = { kind, outcome, reason };
    const seq = optStr(o, 'seq');
    if (seq !== undefined) out.seq = BigInt(seq);
    if (o.hcsHash !== undefined) out.hcsHash = hex(o, 'hcsHash');
    const cid = optStr(o, 'cid');
    if (cid !== undefined) out.cid = cid;
    return out;
  }
  if (outcome !== 'held') throw new Error('journal: unknown slot outcome');
  const held: HeldSlot = {
    kind,
    outcome,
    seq: BigInt(str(o, 'seq')),
    hcsHash: hex(o, 'hcsHash'),
    cid: str(o, 'cid'),
    payer: str(o, 'payer'),
    consensusAt: str(o, 'consensusAt'),
    bytes: hexToBytes(str(o, 'bytes') as Hex),
  };
  if (o.refs !== undefined) {
    const r = obj(o.refs, 'slot refs');
    const reason = str(r, 'reason');
    if (reason !== 'not_named' && !isReason(reason)) throw new Error('journal: unknown refs reason');
    held.refs = { seq: BigInt(str(r, 'seq')), hash: hex(r, 'hash'), reason };
  }
  return held;
}
