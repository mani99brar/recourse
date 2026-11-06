// Reads the records topic from the mirror node. Every message is decoded with the shared record
// message codec; a message that does not decode is returned flagged, never thrown on. `refsFor`
// builds the on-chain record pointers of an order from the first message of each kind whose payer
// is an allowed writer for that kind: given the order's platform and shop, only their own writers.

import type { Hex } from 'viem';
import {
  ZERO_HASH,
  decodeRecordMsg,
  emptyRecordRefs,
  hcsWritersFor,
  orderWritersFor,
  type OrderParties,
  type Parties,
  type RecordKind,
  type RecordRefs,
} from '@recourse/shared';
import type { MirrorClient, MirrorTopicMessageRaw } from './mirror.js';

interface MsgBase {
  seq: number;
  /** Mirror node consensus timestamp, `seconds.nanos`. */
  consensusAt: string;
  /** Mirror node `payer_account_id`; null when the mirror node does not report it. */
  payer: string | null;
}

export interface ValidRecordMsg extends MsgBase {
  valid: true;
  v: '1';
  orderId: Hex;
  kind: RecordKind;
  hash: Hex;
  cid: string;
}

export interface InvalidRecordMsg extends MsgBase {
  valid: false;
  error: string;
}

export type RecordMsg = ValidRecordMsg | InvalidRecordMsg;

export function decodeTopicMessage(raw: MirrorTopicMessageRaw): RecordMsg {
  const base: MsgBase = { seq: raw.sequenceNumber, consensusAt: raw.consensusTimestamp, payer: raw.payerAccountId };
  if (raw.chunkInfo && raw.chunkInfo.total !== 1) return { ...base, valid: false, error: 'chunked message' };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(raw.message, 'base64'));
  } catch {
    return { ...base, valid: false, error: 'message is not base64' };
  }
  const decoded = decodeRecordMsg(bytes);
  if (!decoded.ok) return { ...base, valid: false, error: decoded.error };
  const { cid, hash, kind, orderId } = decoded.value;
  return { ...base, valid: true, v: '1', orderId, kind, hash, cid };
}

/** `0.0.N` -> N, as RecordRefs.topicNum. */
export function topicNumOf(topicId: string): bigint {
  const m = /^0\.0\.(\d+)$/.exec(topicId);
  if (!m) throw new Error(`topic id must be 0.0.N: ${topicId}`);
  return BigInt(m[1]!);
}

/**
 * The first message of each kind for the order whose payer is in that kind's writer set.
 * Missing kinds keep seq 0 and the zero hash. With `order` (the order's platform and shop
 * addresses, as the claim will name them), the writer set is that platform's or shop's own
 * hcsWriters, which is what the pre-check accepts; without it, any party of the role counts.
 */
export function refsFromMessages(
  topicId: string,
  orderId: Hex,
  messages: readonly RecordMsg[],
  parties: Parties,
  order?: OrderParties,
): RecordRefs {
  const refs = emptyRecordRefs(topicNumOf(topicId));
  const seq = [...refs.seq] as [bigint, bigint, bigint, bigint, bigint, bigint];
  const hashes = [...refs.hashes] as [Hex, Hex, Hex, Hex, Hex, Hex];
  const target = orderId.toLowerCase();
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  for (const m of sorted) {
    if (!m.valid || m.orderId !== target || m.payer === null) continue;
    if (hashes[m.kind] !== ZERO_HASH) continue;
    const writers = order === undefined ? hcsWritersFor(parties, m.kind) : orderWritersFor(parties, m.kind, order);
    if (!writers.has(m.payer)) continue;
    seq[m.kind] = BigInt(m.seq);
    hashes[m.kind] = m.hash;
  }
  return { topicNum: refs.topicNum, seq, hashes };
}

/** Keeps an in-memory copy of the topic, paging forward from the last sequence number it has read. */
export class TopicReader {
  private readonly messages: RecordMsg[] = [];
  private nextSeq = 1;

  constructor(
    private readonly mirror: MirrorClient,
    readonly topicId: string,
    private readonly pageSize = 100,
  ) {}

  /** One page of messages from `fromSeq`, decoded; reads the mirror node directly. */
  async readTopic(fromSeq: number, limit = this.pageSize): Promise<RecordMsg[]> {
    const raws = await this.mirror.topicMessages(this.topicId, fromSeq, Math.min(limit, 100));
    return raws.map(decodeTopicMessage);
  }

  /** Pulls every message newer than the last one read. Returns how many were added. */
  async sync(maxPages = 1000): Promise<number> {
    let added = 0;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.readTopic(this.nextSeq, this.pageSize);
      for (const m of batch) {
        if (m.seq < this.nextSeq) continue;
        this.messages.push(m);
        this.nextSeq = m.seq + 1;
        added += 1;
      }
      if (batch.length < this.pageSize) break;
    }
    return added;
  }

  /** Valid messages for the order at or after `fromSeq`, oldest first, after syncing. */
  async readOrderRecords(orderId: Hex, fromSeq = 1): Promise<ValidRecordMsg[]> {
    await this.sync();
    const target = orderId.toLowerCase();
    return this.messages.filter((m): m is ValidRecordMsg => m.valid && m.orderId === target && m.seq >= fromSeq);
  }

  async refsFor(orderId: Hex, parties: Parties, order?: OrderParties): Promise<RecordRefs> {
    return refsFromMessages(this.topicId, orderId, await this.readOrderRecords(orderId), parties, order);
  }

  /** Highest sequence number read so far (0 before the first sync). */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }
}
