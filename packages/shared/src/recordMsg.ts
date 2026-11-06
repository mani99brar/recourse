// HCS record message: one per record, on the records topic. The body is canonical JSON with
// exactly five string fields, so its bytes are always
// {"cid":"…","hash":"0x…","kind":"<0-5>","orderId":"0x…","v":"1"}
// The cid must be the raw-block CIDv1 of the hash (`rawCidOfHash`), so a message can never point
// at a document other than the one its hash names, and every reader can fetch by the hash alone.

import type { Hex } from 'viem';
import { rawCidOfHash } from './cid.js';
import { canonicalBytes, isHex32, parseCanonical } from './hashing.js';
import { isRecordKind, type RecordKind } from './records.js';

export const RECORD_MSG_VERSION = '1';
export const RECORD_MSG_MAX_BYTES = 1024;

export interface RecordMsgFields {
  /** IPFS CID of the record document: always `rawCidOfHash(hash)`. */
  cid: string;
  /** recordHash of the document bytes, `0x` + 64 lowercase hex. */
  hash: Hex;
  kind: RecordKind;
  orderId: Hex;
}

export type RecordMsgResult = { ok: true; value: RecordMsgFields } | { ok: false; error: string };

const CID = /^[A-Za-z0-9]+$/;
const KIND_TEXT = /^[0-5]$/;

function checkFields(f: RecordMsgFields): string | undefined {
  if (typeof f.cid !== 'string' || f.cid === '' || !CID.test(f.cid)) return 'cid must be a non-empty base-encoded CID';
  if (!isHex32(f.hash)) return 'hash must be 0x + 64 lowercase hex';
  if (f.cid !== rawCidOfHash(f.hash)) return 'cid must be the raw SHA-256 CIDv1 of hash';
  if (!isRecordKind(f.kind)) return 'kind must be 0-5';
  if (!isHex32(f.orderId)) return 'orderId must be 0x + 64 lowercase hex';
  return undefined;
}

/** Message bytes for a record. Throws on any field out of shape or a body over 1,024 bytes. */
export function encodeRecordMsg(fields: RecordMsgFields): Uint8Array {
  const problem = checkFields(fields);
  if (problem) throw new RangeError(`encodeRecordMsg: ${problem}`);
  const bytes = canonicalBytes({
    cid: fields.cid,
    hash: fields.hash,
    kind: String(fields.kind),
    orderId: fields.orderId,
    v: RECORD_MSG_VERSION,
  });
  if (bytes.length > RECORD_MSG_MAX_BYTES) throw new RangeError('encodeRecordMsg: body over 1024 bytes');
  return bytes;
}

/** Parses message bytes; anything but the exact canonical five-field body is invalid. */
export function decodeRecordMsg(bytes: Uint8Array): RecordMsgResult {
  if (bytes.length > RECORD_MSG_MAX_BYTES) return { ok: false, error: 'body over 1024 bytes' };
  const parsed = parseCanonical(bytes);
  if (!parsed.ok) return { ok: false, error: 'not canonical JSON' };
  const v = parsed.value;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: 'not an object' };
  const keys = Object.keys(v);
  if (keys.length !== 5 || !['cid', 'hash', 'kind', 'orderId', 'v'].every((k) => keys.includes(k))) {
    return { ok: false, error: 'fields must be exactly cid, hash, kind, orderId, v' };
  }
  const o = v as Record<string, unknown>;
  if (o.v !== RECORD_MSG_VERSION) return { ok: false, error: 'v must be "1"' };
  if (typeof o.kind !== 'string' || !KIND_TEXT.test(o.kind)) return { ok: false, error: 'kind must be "0"-"5"' };
  const fields = { cid: o.cid, hash: o.hash, kind: Number(o.kind), orderId: o.orderId } as RecordMsgFields;
  const problem = checkFields(fields);
  if (problem) return { ok: false, error: problem };
  return { ok: true, value: fields };
}
