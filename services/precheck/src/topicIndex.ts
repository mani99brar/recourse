// Index of the records topic by (orderId, kind) and by sequence number. Built from the mirror
// node's topic messages with its own sequence cursor, written to a journal file so a restart
// reads only what is new. Also tracks how far the index has read and the last tip probe, which
// together say whether a missing record is really missing.
//
// The topic has no submit key: anyone can post to it. So the index holds (and journals) only
// messages that decode as record messages and whose payer writes for some party of the kind's
// role (the agent's accounts for every kind but packed, the shop's for packed). Everything else
// only moves the cursor, which is journaled as a small `cursor` line. What the index holds
// therefore grows with what the parties write, never with what strangers post. The journal is
// replayed line by line, so even an old journal full of junk loads in bounded memory.
//
// A party writer can post as much as it likes too, so what one writer account has held is capped
// twice: the first `heldPerSlot` messages for each order and kind (only the earliest that passes is
// ever used; the rest only move the cursor and are not journaled), and `heldPerWriter` messages in
// all (past it the account's oldest are let go). Both caps count per writer account, so a writer
// that floods only crowds out its own records, never another party's. A record the claim's refs
// name is read from the mirror when the index does not hold it. The same caps apply on replay, and
// a journal holding many lines the index no longer keeps is rewritten compactly.

import { closeSync, existsSync, fsyncSync, openSync, readSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { openJournal, tsSeconds, type Journal, type JournalRecord, type MirrorClient, type TopicMessage } from '@recourse/keeper';
import { decodeRecordMsg, hcsWritersFor, RECORD_MSG_MAX_BYTES, type Parties, type RecordKind, type RecordMsgFields } from '@recourse/shared';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import type { Clock } from './clock.js';

export const TOPIC_INDEX_FILE = 'topic-index.jsonl';
/** Messages held per order, kind and writer account. An honest writer posts one. */
export const HELD_PER_SLOT = 8;
/**
 * Messages held per writer account; past it the account's oldest are let go. About 1.5 KB of heap
 * each: two writers at the cap add about 15 MB, which the unit's memory limit has room for. An
 * honest platform posts five per order, so the index keeps its last thousand orders; a record a
 * claim names is read from the mirror even when the index let it go.
 */
export const HELD_PER_WRITER = 5_000;

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

/** The account a held message is counted against: its payer, else its transaction account, else none known (''). */
function accountOf(m: IndexedMessage): string {
  return m.payer ?? m.txAccount ?? '';
}

function cmpSeq(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inserts into an ascending list: an append when it is the newest (the usual case), else in place. */
function insertSorted(list: bigint[], seq: bigint): void {
  const last = list[list.length - 1];
  if (last === undefined || last < seq) {
    list.push(seq);
    return;
  }
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < seq) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, seq);
}

/** Held sequence numbers of one writer account, oldest first. */
interface WriterQueue {
  seqs: bigint[];
  head: number;
}

/** What the caps let go, per writer account. */
export interface CapCounts {
  /** Messages past `heldPerSlot` for their order and kind: not held. */
  slotDropped: number;
  /** Held messages let go because the account passed `heldPerWriter`. */
  evicted: number;
}

/** Lines of a journal file, read in chunks; a last line with no newline (a crash mid-write) is left out. */
function* journalLines(path: string): Generator<string> {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let rest = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      let buf = rest.length === 0 ? chunk.subarray(0, n) : Buffer.concat([rest, chunk.subarray(0, n)]);
      let nl: number;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        yield buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
      }
      rest = Buffer.from(buf);
    }
  } finally {
    closeSync(fd);
  }
}

function parseLine(line: string): JournalRecord | undefined {
  if (line === '') return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as JournalRecord).t !== 'string') return undefined;
    return value as JournalRecord;
  } catch {
    return undefined;
  }
}

export interface TopicIndexOptions {
  mirror: Pick<MirrorClient, 'topicMessages' | 'newestTopicMessage'>;
  /** Topic id as configured, `shard.realm.num`. */
  topicId: string;
  /** State directory; the index journal lives in it. */
  dir: string;
  clock: Clock;
  /** Party map: a message is kept only when its payer writes for some party of its kind's role. */
  parties: Parties;
  pageSize?: number;
  /** Pages read per `advance` call at most. Default 200, so a backlog of junk is caught up quickly. */
  maxPages?: number;
  /** Time one `advance` call may spend reading pages, ms by the clock. Default 10 s. */
  budgetMs?: number;
  /**
   * A journal with more cursor lines and lines no longer held than this is rewritten compactly when
   * opened; while running, once the lines no longer held pass this and the number held. Default 1000.
   */
  compactAfter?: number;
  /** Messages held per order, kind and writer account. Default HELD_PER_SLOT. */
  heldPerSlot?: number;
  /** Messages held per writer account. Default HELD_PER_WRITER. */
  heldPerWriter?: number;
  log?: (line: string) => void;
}

export class TopicIndex {
  private readonly bySeq = new Map<bigint, IndexedMessage>();
  private readonly byKey = new Map<string, bigint[]>();
  /** Held messages per order, kind and writer account. */
  private readonly perSlot = new Map<string, number>();
  private readonly perWriter = new Map<string, WriterQueue>();
  private readonly caps = new Map<string, CapCounts>();
  /** Message lines in the journal file that the index does not hold (let go, or kept by an older version). */
  private dead = 0;
  private readonly writers: { platform: Set<string>; shop: Set<string> };
  private journal: Journal;
  private last = 0n;
  private lastTs: string | undefined;
  /** Highest sequence number the journal accounts for (a kept message or a cursor line). */
  private journaled = 0n;
  private probeState: TipProbe | undefined;

  private constructor(private readonly o: TopicIndexOptions) {
    this.writers = { platform: hcsWritersFor(o.parties, 0), shop: hcsWritersFor(o.parties, 4) };
    const cursorLines = this.replay();
    this.journal = openJournal(o.dir, TOPIC_INDEX_FILE);
    if (cursorLines + this.dead > (o.compactAfter ?? 1000)) this.compact();
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

  /** Highest sequence number read so far, kept or not; 0n when nothing was read. */
  get lastSeq(): bigint {
    return this.last;
  }

  /** Consensus timestamp of the last message read, kept or not. */
  get lastConsensus(): string | undefined {
    return this.lastTs;
  }

  get probe(): TipProbe | undefined {
    return this.probeState;
  }

  /** Messages held (record messages from party writers). */
  get size(): number {
    return this.bySeq.size;
  }

  /** What the caps let go so far, by writer account (only accounts a cap was hit for). */
  capped(): Record<string, CapCounts> {
    return Object.fromEntries([...this.caps].map(([account, c]) => [account, { ...c }]));
  }

  get(seq: bigint): IndexedMessage | undefined {
    return this.bySeq.get(seq);
  }

  /** Held messages for this order and kind, oldest first. */
  candidates(orderId: Hex, kind: RecordKind): IndexedMessage[] {
    const seqs = this.byKey.get(keyOf(orderId, kind)) ?? [];
    return seqs.map((s) => this.bySeq.get(s)).filter((m): m is IndexedMessage => m !== undefined);
  }

  /**
   * True when the index holds the message: it decodes as a record message and its payer (or, with
   * no payer, its transaction account) writes for some party of the kind's role. A message with
   * neither account is held; the proof looks its payer up and checks it then.
   */
  private keeps(m: IndexedMessage): boolean {
    if (!m.decoded.ok) return false;
    const account = m.payer ?? m.txAccount;
    if (account === undefined) return true;
    return (m.decoded.value.kind === 4 ? this.writers.shop : this.writers.platform).has(account);
  }

  /** Moves the read cursor. */
  private see(seq: bigint, ts: string): void {
    if (seq > this.last) {
      this.last = seq;
      this.lastTs = ts;
    }
  }

  private slotKey(m: IndexedMessage): string {
    const f = m.decoded.ok ? m.decoded.value : undefined;
    return `${f?.orderId.toLowerCase()}:${f?.kind}:${accountOf(m)}`;
  }

  private cap(account: string, which: keyof CapCounts, line: string): void {
    let c = this.caps.get(account);
    if (c === undefined) {
      c = { slotDropped: 0, evicted: 0 };
      this.caps.set(account, c);
    }
    if (c[which] === 0) this.o.log?.(line);
    c[which] += 1;
  }

  /**
   * True when a message the index keeps also fits under the per-slot cap; counts it when not. A
   * message already held (a replayed line read again) fits.
   */
  private admits(m: IndexedMessage): boolean {
    if (this.bySeq.has(m.seq)) return false;
    if ((this.perSlot.get(this.slotKey(m)) ?? 0) < (this.o.heldPerSlot ?? HELD_PER_SLOT)) return true;
    const account = accountOf(m);
    this.cap(account, 'slotDropped', `topic index: writer ${account || '(unknown)'} posted more than ${this.o.heldPerSlot ?? HELD_PER_SLOT} messages for one order and kind; later ones are not held`);
    return false;
  }

  /** Holds a message that `keeps` and `admits`; lets the writer's oldest go when it is over its cap. */
  private add(m: IndexedMessage): void {
    if (this.bySeq.has(m.seq) || !m.decoded.ok) return;
    this.bySeq.set(m.seq, m);
    const k = keyOf(m.decoded.value.orderId, m.decoded.value.kind);
    let list = this.byKey.get(k);
    if (list === undefined) {
      list = [];
      this.byKey.set(k, list);
    }
    insertSorted(list, m.seq);
    const sk = this.slotKey(m);
    this.perSlot.set(sk, (this.perSlot.get(sk) ?? 0) + 1);
    const account = accountOf(m);
    let q = this.perWriter.get(account);
    if (q === undefined) {
      q = { seqs: [], head: 0 };
      this.perWriter.set(account, q);
    }
    q.seqs.push(m.seq);
    const limit = this.o.heldPerWriter ?? HELD_PER_WRITER;
    while (q.seqs.length - q.head > limit) {
      const oldest = q.seqs[q.head]!;
      q.head += 1;
      this.drop(oldest);
      this.cap(account, 'evicted', `topic index: writer ${account || '(unknown)'} has over ${limit} messages held; its oldest are let go`);
    }
    if (q.head > 1024 && q.head * 2 > q.seqs.length) {
      q.seqs = q.seqs.slice(q.head);
      q.head = 0;
    }
  }

  /** Lets one held message go (its journal line stays until the next rewrite). */
  private drop(seq: bigint): void {
    const m = this.bySeq.get(seq);
    if (m === undefined || !m.decoded.ok) return;
    this.bySeq.delete(seq);
    this.dead += 1;
    const k = keyOf(m.decoded.value.orderId, m.decoded.value.kind);
    const list = this.byKey.get(k);
    if (list !== undefined) {
      const i = list.indexOf(seq);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byKey.delete(k);
    }
    const sk = this.slotKey(m);
    const n = (this.perSlot.get(sk) ?? 1) - 1;
    if (n <= 0) this.perSlot.delete(sk);
    else this.perSlot.set(sk, n);
  }

  private reset(): void {
    this.bySeq.clear();
    this.byKey.clear();
    this.perSlot.clear();
    this.perWriter.clear();
    this.caps.clear();
    this.dead = 0;
    this.last = 0n;
    this.lastTs = undefined;
    this.journaled = 0n;
  }

  /** Reads the journal back line by line. Returns the number of cursor lines it held. */
  private replay(): number {
    const path = join(this.o.dir, TOPIC_INDEX_FILE);
    if (!existsSync(path)) return 0;
    let n = 0;
    let cursors = 0;
    for (const line of journalLines(path)) {
      n += 1;
      const r = parseLine(line);
      if (r === undefined) {
        // The index is a cache of the topic: set the damaged file aside and read the topic again.
        this.o.log?.(`topic index journal had a bad line ${n}; reading the topic again from the start`);
        renameSync(path, join(this.o.dir, `${TOPIC_INDEX_FILE}.damaged-${this.o.clock.now()}`));
        this.reset();
        return 0;
      }
      if (r.t === 'msg') {
        const m = this.fromRecord(r);
        this.see(m.seq, m.consensusAt);
        if (m.seq > this.journaled) this.journaled = m.seq;
        // An older journal also held messages the index no longer keeps; they only move the cursor.
        if (this.keeps(m) && this.admits(m)) this.add(m);
        else this.dead += 1;
      } else if (r.t === 'cursor') {
        cursors += 1;
        const seq = BigInt(String(r.seq));
        this.see(seq, String(r.ts));
        if (seq > this.journaled) this.journaled = seq;
      }
    }
    return cursors;
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

  private msgRecord(m: IndexedMessage, size: number): JournalRecord {
    return { t: 'msg', seq: m.seq.toString(), ts: m.consensusAt, payer: m.payer, tx: m.txAccount, chunks: m.chunkTotal, size, hex: bytesToHex(m.bytes) };
  }

  /** Journals the cursor when the last messages read were not kept, so a restart does not read them again. */
  private journalCursor(): void {
    if (this.last <= this.journaled || this.lastTs === undefined) return;
    this.journal.append({ t: 'cursor', seq: this.last.toString(), ts: this.lastTs });
    this.journaled = this.last;
  }

  /** Rewrites the journal as the held messages plus one cursor line (write, fsync, rename). */
  private compact(): void {
    const path = join(this.o.dir, TOPIC_INDEX_FILE);
    const tmp = `${path}.compact-${process.pid}`;
    const fd = openSync(tmp, 'w');
    try {
      const at = this.o.clock.now();
      const seqs = [...this.bySeq.keys()].sort(cmpSeq);
      for (const s of seqs) {
        const m = this.bySeq.get(s)!;
        writeSync(fd, `${JSON.stringify({ ...this.msgRecord(m, m.bytes.length), at })}\n`);
      }
      if (this.lastTs !== undefined) writeSync(fd, `${JSON.stringify({ t: 'cursor', seq: this.last.toString(), ts: this.lastTs, at })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.journal.close();
    renameSync(tmp, path);
    this.journal = openJournal(this.o.dir, TOPIC_INDEX_FILE);
    this.dead = 0;
    this.o.log?.(`topic index journal compacted to ${this.bySeq.size} messages and a cursor at ${this.last}`);
  }

  /**
   * Reads new messages from the mirror until it has none newer, at most `maxPages` pages or
   * `budgetMs` of reading. Returns how many messages were read (kept or not). A mirror failure
   * throws (TransientError); what was read before it stays read.
   */
  async advance(): Promise<number> {
    let read = 0;
    const started = this.o.clock.now();
    try {
      for (let page = 0; page < (this.o.maxPages ?? 200); page++) {
        const { messages, more } = await this.o.mirror.topicMessages(this.o.topicId, this.last + 1n, this.o.pageSize ?? 100);
        for (const raw of messages) {
          if (raw.seq <= this.last) continue;
          const m = toIndexed(raw);
          if (this.keeps(m) && this.admits(m)) {
            this.journal.append(this.msgRecord(m, raw.bytes.length));
            this.journaled = m.seq;
            this.add(m);
          }
          this.see(m.seq, m.consensusAt);
          read += 1;
        }
        if (!more || messages.length === 0) break;
        if (this.o.clock.now() - started >= (this.o.budgetMs ?? 10_000)) break;
      }
    } finally {
      this.journalCursor();
    }
    // Lines of messages let go since the last rewrite: rewrite once they outnumber what is held.
    if (this.dead > Math.max(this.o.compactAfter ?? 1000, this.bySeq.size)) this.compact();
    return read;
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
