// Reads the records topic from the mirror node. Every message is decoded with the shared record
// message codec; a message that does not decode is returned flagged, never thrown on, and the
// reader keeps only valid ones. `refsFor`
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

/** True for a message whose payer some party may use for its kind (the role-wide writer set). */
export function writerFilter(parties: Parties): (m: ValidRecordMsg) => boolean {
  const byKind = new Map<number, Set<string>>();
  return (m) => {
    if (m.payer === null) return true; // the mirror did not say; the reader of the order decides
    let set = byKind.get(m.kind);
    if (set === undefined) {
      set = hcsWritersFor(parties, m.kind);
      byKind.set(m.kind, set);
    }
    return set.has(m.payer);
  };
}

/** Messages a reader holds per order, kind and payer. An honest writer posts one; refs use the first. */
export const READER_HELD_PER_SLOT = 8;
/** Messages a reader holds per payer account; past it the account's oldest are let go. */
export const READER_HELD_PER_WRITER = 5_000;

export interface TopicReaderOptions {
  pageSize?: number;
  /** Messages held per order, kind and payer; later ones are dropped. Default READER_HELD_PER_SLOT. */
  heldPerSlot?: number;
  /** Messages held per payer account; past it the account's oldest are let go. Default READER_HELD_PER_WRITER. */
  heldPerWriter?: number;
  /**
   * Keeps a valid message only when this returns true, for example `writerFilter(parties)`. The
   * topic has no submit key, so without a filter every well-formed message anyone posts is kept.
   */
  keep?: (m: ValidRecordMsg) => boolean;
}

/**
 * Keeps an in-memory index of the topic's record messages by order, paging forward from the last
 * sequence number it has read. Messages that do not decode (and, with `keep`, messages from
 * accounts that write for no party) are counted and dropped, never held: anyone can post to the
 * topic, so what is held must not grow with what strangers post. What one payer has held is capped
 * too: the first `heldPerSlot` messages per order and kind (refs use the first), and `heldPerWriter`
 * in all, past which its oldest are let go. So with `keep`, what is held is bounded by the number
 * of party writers; without it, each payer is bounded but the number of payers is not.
 */
export class TopicReader {
  private readonly byOrder = new Map<string, ValidRecordMsg[]>();
  /** Held messages per order, kind and payer. */
  private readonly perSlot = new Map<string, number>();
  /** Held messages per payer, oldest first (`head` is the oldest still held). */
  private readonly perWriter = new Map<string, { held: ValidRecordMsg[]; head: number }>();
  private nextSeq = 1;
  private droppedCount = 0;
  private cappedCount = 0;
  private readonly heldPerSlot: number;
  private readonly heldPerWriter: number;
  private running: Promise<number> | undefined;
  private readonly pageSize: number;
  private readonly keep: ((m: ValidRecordMsg) => boolean) | undefined;

  constructor(
    private readonly mirror: MirrorClient,
    readonly topicId: string,
    options: number | TopicReaderOptions = {},
  ) {
    const o = typeof options === 'number' ? { pageSize: options } : options;
    // The mirror serves at most 100 messages a page; a short page means the reader has caught up.
    this.pageSize = Math.min(o.pageSize ?? 100, 100);
    this.keep = o.keep;
    this.heldPerSlot = o.heldPerSlot ?? READER_HELD_PER_SLOT;
    this.heldPerWriter = o.heldPerWriter ?? READER_HELD_PER_WRITER;
  }

  /** One page of messages from `fromSeq`, decoded; reads the mirror node directly. */
  async readTopic(fromSeq: number, limit = this.pageSize): Promise<RecordMsg[]> {
    const raws = await this.mirror.topicMessages(this.topicId, fromSeq, Math.min(limit, 100));
    return raws.map(decodeTopicMessage);
  }

  /**
   * Pulls every message newer than the last one read, until the mirror returns a short page (the
   * reader has caught up) or `maxPages` pages were read. Returns how many messages were read. Calls
   * made while one is running wait for it instead of reading the same pages again.
   */
  async sync(maxPages = Number.POSITIVE_INFINITY): Promise<number> {
    while (this.running !== undefined) await this.running.catch(() => undefined);
    const run = this.pull(maxPages);
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = undefined;
    }
  }

  private async pull(maxPages: number): Promise<number> {
    let read = 0;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.readTopic(this.nextSeq, this.pageSize);
      for (const m of batch) {
        if (m.seq < this.nextSeq) continue;
        this.nextSeq = m.seq + 1;
        read += 1;
        if (!m.valid || (this.keep !== undefined && !this.keep(m))) {
          this.droppedCount += 1;
          continue;
        }
        this.hold(m);
      }
      if (batch.length < this.pageSize) break;
    }
    return read;
  }

  private hold(m: ValidRecordMsg): void {
    const payer = m.payer ?? '';
    const slot = `${m.orderId}:${m.kind}:${payer}`;
    const n = this.perSlot.get(slot) ?? 0;
    if (n >= this.heldPerSlot) {
      this.cappedCount += 1;
      return;
    }
    this.perSlot.set(slot, n + 1);
    const list = this.byOrder.get(m.orderId) ?? [];
    list.push(m);
    this.byOrder.set(m.orderId, list);
    let q = this.perWriter.get(payer);
    if (q === undefined) {
      q = { held: [], head: 0 };
      this.perWriter.set(payer, q);
    }
    q.held.push(m);
    while (q.held.length - q.head > this.heldPerWriter) {
      const oldest = q.held[q.head]!;
      q.head += 1;
      this.cappedCount += 1;
      this.letGo(oldest);
    }
    if (q.head > 1024 && q.head * 2 > q.held.length) {
      q.held = q.held.slice(q.head);
      q.head = 0;
    }
  }

  private letGo(m: ValidRecordMsg): void {
    const list = this.byOrder.get(m.orderId);
    if (list !== undefined) {
      const i = list.indexOf(m);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byOrder.delete(m.orderId);
    }
    const slot = `${m.orderId}:${m.kind}:${m.payer ?? ''}`;
    const n = (this.perSlot.get(slot) ?? 1) - 1;
    if (n <= 0) this.perSlot.delete(slot);
    else this.perSlot.set(slot, n);
  }

  /** Valid kept messages for the order at or after `fromSeq`, oldest first, after syncing. */
  async readOrderRecords(orderId: Hex, fromSeq = 1): Promise<ValidRecordMsg[]> {
    await this.sync();
    return (this.byOrder.get(orderId.toLowerCase()) ?? []).filter((m) => m.seq >= fromSeq);
  }

  async refsFor(orderId: Hex, parties: Parties, order?: OrderParties): Promise<RecordRefs> {
    return refsFromMessages(this.topicId, orderId, await this.readOrderRecords(orderId), parties, order);
  }

  /** Highest sequence number read so far (0 before the first sync). */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Messages read and not kept: they did not decode, or (with `keep`) no party writes with their payer. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Valid kept messages the caps let go: past `heldPerSlot` for their order and kind, or a payer's oldest past `heldPerWriter`. */
  get capped(): number {
    return this.cappedCount;
  }
}
