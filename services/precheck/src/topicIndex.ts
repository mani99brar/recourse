// Index of the records topic by (orderId, kind) and by sequence number. Built from the mirror
// node's topic messages with its own sequence cursor, written to a journal file so a restart
// reads only what is new. Also tracks how far the index has read and the last tip probe, which
// together say whether a missing record is really missing.

import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { openJournal, replayJournal, tsSeconds, type Journal, type JournalRecord, type MirrorClient, type TopicMessage } from '@recourse/keeper';
import { decodeRecordMsg, RECORD_MSG_MAX_BYTES, type RecordKind, type RecordMsgFields } from '@recourse/shared';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import type { Clock } from './clock.js';

export const TOPIC_INDEX_FILE = 'topic-index.jsonl';

export interface IndexedMessage {
  seq: bigint;
  /** Mirror consensus timestamp, "<s>.<ns>". */
  consensusAt: string;
  /** `payer_account_id` as the mirror gave it. */
  payer?: string;
  /** Account of the transaction id, when the mirror gave one with the message. */
  txAccount?: string;
  /** Message body; empty when the body was over the record message limit (it can never decode). */
  bytes: Uint8Array;
  chunkTotal: number;
  decoded: { ok: true; value: RecordMsgFields } | { ok: false; error: string };
}

export interface TipProbe {
  /** Wall time the probe was started, unix ms. */
  atMs: number;
  /** Newest sequence number on the topic then; 0n when the topic was empty. */
  newestSeq: bigint;
  newestConsensus?: string;
}

function decode(bytes: Uint8Array, size: number, chunkTotal: number): IndexedMessage['decoded'] {
  if (chunkTotal > 1) return { ok: false, error: 'chunked message' };
  if (size > RECORD_MSG_MAX_BYTES) return { ok: false, error: 'body over 1024 bytes' };
  return decodeRecordMsg(bytes);
}

/** Wraps a mirror message the way the index holds it. */
export function toIndexed(m: TopicMessage): IndexedMessage {
  const oversize = m.bytes.length > RECORD_MSG_MAX_BYTES;
  const out: IndexedMessage = {
    seq: m.seq,
    consensusAt: m.consensusTimestamp,
    bytes: oversize ? new Uint8Array(0) : m.bytes,
    chunkTotal: m.chunkTotal,
    decoded: decode(m.bytes, m.bytes.length, m.chunkTotal),
  };
  if (m.payer !== undefined) out.payer = m.payer;
  if (m.txAccount !== undefined) out.txAccount = m.txAccount;
  return out;
}

function keyOf(orderId: Hex, kind: RecordKind): string {
  return `${orderId.toLowerCase()}:${kind}`;
}

export interface TopicIndexOptions {
  mirror: Pick<MirrorClient, 'topicMessages' | 'newestTopicMessage'>;
  /** Topic id as configured, `shard.realm.num`. */
  topicId: string;
  /** State directory; the index journal lives in it. */
  dir: string;
  clock: Clock;
  pageSize?: number;
  /** Pages read per `advance` call. Default 5. */
  maxPages?: number;
  log?: (line: string) => void;
}

export class TopicIndex {
  private readonly bySeq = new Map<bigint, IndexedMessage>();
  private readonly byKey = new Map<string, bigint[]>();
  private readonly journal: Journal;
  private last = 0n;
  private lastTs: string | undefined;
  private probeState: TipProbe | undefined;

  private constructor(private readonly o: TopicIndexOptions) {
    const replay = replayJournal(o.dir, TOPIC_INDEX_FILE);
    if (replay.badLines.length > 0) {
      // The index is a cache of the topic: set the damaged file aside and read the topic again.
      o.log?.(`topic index journal had bad lines ${replay.badLines.join(',')}; reading the topic again from the start`);
      renameSync(join(o.dir, TOPIC_INDEX_FILE), join(o.dir, `${TOPIC_INDEX_FILE}.damaged-${o.clock.now()}`));
    } else {
      for (const r of replay.records) {
        if (r.t === 'msg') this.add(this.fromRecord(r));
      }
    }
    this.journal = openJournal(o.dir, TOPIC_INDEX_FILE);
  }

  static open(o: TopicIndexOptions): TopicIndex {
    return new TopicIndex(o);
  }

  close(): void {
    this.journal.close();
  }

  get topicId(): string {
    return this.o.topicId;
  }

  /** Highest sequence number read so far; 0n when nothing was read. */
  get lastSeq(): bigint {
    return this.last;
  }

  /** Consensus timestamp of the last message read. */
  get lastConsensus(): string | undefined {
    return this.lastTs;
  }

  get probe(): TipProbe | undefined {
    return this.probeState;
  }

  get size(): number {
    return this.bySeq.size;
  }

  get(seq: bigint): IndexedMessage | undefined {
    return this.bySeq.get(seq);
  }

  /** Decoded messages for this order and kind, oldest first. */
  candidates(orderId: Hex, kind: RecordKind): IndexedMessage[] {
    const seqs = this.byKey.get(keyOf(orderId, kind)) ?? [];
    return seqs.map((s) => this.bySeq.get(s)).filter((m): m is IndexedMessage => m !== undefined);
  }

  private add(m: IndexedMessage): void {
    if (this.bySeq.has(m.seq)) return;
    this.bySeq.set(m.seq, m);
    if (m.seq > this.last) {
      this.last = m.seq;
      this.lastTs = m.consensusAt;
    }
    if (m.decoded.ok) {
      const k = keyOf(m.decoded.value.orderId, m.decoded.value.kind);
      const list = this.byKey.get(k) ?? [];
      list.push(m.seq);
      list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      this.byKey.set(k, list);
    }
  }

  private fromRecord(r: JournalRecord): IndexedMessage {
    const chunkTotal = Number(r.chunks);
    const size = Number(r.size);
    const bytes = hexToBytes(String(r.hex) as Hex);
    const m: IndexedMessage = {
      seq: BigInt(String(r.seq)),
      consensusAt: String(r.ts),
      bytes,
      chunkTotal,
      decoded: decode(bytes, size, chunkTotal),
    };
    if (typeof r.payer === 'string') m.payer = r.payer;
    if (typeof r.tx === 'string') m.txAccount = r.tx;
    return m;
  }

  /**
   * Reads new messages from the mirror, at most `maxPages` pages. Returns how many were added.
   * A mirror failure throws (TransientError) and leaves the index as it was.
   */
  async advance(): Promise<number> {
    let added = 0;
    for (let page = 0; page < (this.o.maxPages ?? 5); page++) {
      const { messages, more } = await this.o.mirror.topicMessages(this.o.topicId, this.last + 1n, this.o.pageSize ?? 100);
      for (const raw of messages) {
        if (raw.seq <= this.last) continue;
        const m = toIndexed(raw);
        this.journal.append({
          t: 'msg',
          seq: m.seq.toString(),
          ts: m.consensusAt,
          payer: m.payer,
          tx: m.txAccount,
          chunks: m.chunkTotal,
          size: raw.bytes.length,
          hex: bytesToHex(m.bytes),
        });
        this.add(m);
        added += 1;
      }
      if (!more) break;
    }
    return added;
  }

  /** Asks the mirror for the newest message on the topic and remembers the answer with the time it was asked. */
  async probeTip(): Promise<TipProbe> {
    const atMs = this.o.clock.now();
    const newest = await this.o.mirror.newestTopicMessage(this.o.topicId);
    const p: TipProbe = { atMs, newestSeq: newest?.seq ?? 0n };
    if (newest !== null) p.newestConsensus = newest.consensusTimestamp;
    this.probeState = p;
    return p;
  }

  /** True when a probe is needed to settle a claim filed at `filedAt`: the quiet wait is over and no later probe exists. */
  needsProbe(filedAt: bigint, quietS: number): boolean {
    const quietAt = filedAt + BigInt(quietS);
    const nowS = BigInt(Math.floor(this.o.clock.now() / 1000));
    if (nowS < quietAt) return false;
    return this.probeState === undefined || BigInt(Math.floor(this.probeState.atMs / 1000)) < quietAt;
  }

  /**
   * True once every message with consensus time up to `filedAt` (whole seconds) has been read.
   * Either the index has read a message after `filedAt`, or the topic is quiet: the clock is at
   * least `quietS` past `filedAt`, a probe started after that shows the newest message at or
   * before `filedAt` (or none), and the index has read up to that message.
   */
  readThrough(filedAt: bigint, quietS: number): boolean {
    if (this.lastTs !== undefined && tsSeconds(this.lastTs) > filedAt) return true;
    const quietAt = filedAt + BigInt(quietS);
    const nowS = BigInt(Math.floor(this.o.clock.now() / 1000));
    if (nowS < quietAt) return false;
    const p = this.probeState;
    if (p === undefined || BigInt(Math.floor(p.atMs / 1000)) < quietAt) return false;
    if (p.newestConsensus !== undefined && tsSeconds(p.newestConsensus) > filedAt) return false;
    return this.last >= p.newestSeq;
  }
}
