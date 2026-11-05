// Hedera mirror node client: contract logs, topic messages, transaction payers and the newest
// block. The mirror node only serves consensus data, so everything it returns is final.

import type { Hex } from 'viem';
import { loadCursor, saveCursor } from './cursor.js';
import { getJson, type FetchLike, TransientError } from './net.js';
import { compareTs, tsMinusSeconds } from './timestamps.js';

export interface MirrorLog {
  /** Lower-case EVM address of the emitting contract. */
  address: Hex;
  data: Hex;
  /** Log index within the transaction's record. */
  index: number;
  topics: Hex[];
  /** Consensus timestamp, "<s>.<ns>". */
  timestamp: string;
  transactionHash: Hex;
  blockNumber: number;
}

export interface TopicMessage {
  topicId: string;
  seq: bigint;
  consensusTimestamp: string;
  /** `payer_account_id` as the mirror node reports it. */
  payer?: string;
  /** Account of the transaction id, when the mirror gives one with the message (chunked messages). */
  txAccount?: string;
  bytes: Uint8Array;
  /** Number of chunks; 1 for an ordinary message. */
  chunkTotal: number;
}

interface RawLog {
  address: string;
  data: string | null;
  index: number;
  topics: string[];
  timestamp: string;
  transaction_hash: string;
  block_number: number;
}

interface RawMessage {
  topic_id: string;
  sequence_number: number | string;
  consensus_timestamp: string;
  payer_account_id?: string | null;
  message: string;
  chunk_info?: { total?: number; initial_transaction_id?: { account_id?: string } | null } | null;
}

interface Page<T> {
  links?: { next?: string | null };
  logs?: T[];
  messages?: T[];
}

export interface MirrorOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function toLog(r: RawLog): MirrorLog {
  return {
    address: r.address.toLowerCase() as Hex,
    data: (r.data ?? '0x') as Hex,
    index: r.index,
    topics: r.topics.map((t) => t.toLowerCase() as Hex),
    timestamp: r.timestamp,
    transactionHash: r.transaction_hash.toLowerCase() as Hex,
    blockNumber: r.block_number,
  };
}

function toMessage(r: RawMessage): TopicMessage {
  const m: TopicMessage = {
    topicId: r.topic_id,
    seq: BigInt(r.sequence_number),
    consensusTimestamp: r.consensus_timestamp,
    bytes: base64ToBytes(r.message),
    chunkTotal: r.chunk_info?.total ?? 1,
  };
  if (typeof r.payer_account_id === 'string' && r.payer_account_id !== '') m.payer = r.payer_account_id;
  const acct = r.chunk_info?.initial_transaction_id?.account_id;
  if (typeof acct === 'string' && acct !== '') m.txAccount = acct;
  return m;
}

/** Base URL without a trailing slash or `/api/v1`. */
export function mirrorBase(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

export class MirrorClient {
  readonly base: string;
  private readonly http: { fetch?: FetchLike; timeoutMs?: number };

  constructor(opts: MirrorOptions) {
    this.base = mirrorBase(opts.baseUrl);
    this.http = { fetch: opts.fetch, timeoutMs: opts.timeoutMs };
  }

  private async get<T>(pathAndQuery: string): Promise<T | null> {
    return getJson<T>(`${this.base}${pathAndQuery}`, this.http);
  }

  /**
   * Logs of one contract at or after `fromTimestamp`, oldest first, following pagination for at
   * most `maxPages` pages. `complete` is false when more pages remain.
   */
  async contractLogsSince(
    contract: string,
    fromTimestamp: string,
    maxPages = 20,
  ): Promise<{ logs: MirrorLog[]; complete: boolean }> {
    let path: string | null = `/api/v1/contracts/${contract}/results/logs?timestamp=gte:${fromTimestamp}&order=asc&limit=100`;
    const logs: MirrorLog[] = [];
    for (let page = 0; page < maxPages && path !== null; page++) {
      const body: Page<RawLog> | null = await this.get<Page<RawLog>>(path);
      if (body === null) return { logs, complete: true }; // unknown contract: nothing yet
      for (const r of body.logs ?? []) logs.push(toLog(r));
      path = body.links?.next ?? null;
    }
    return { logs, complete: path === null };
  }

  /** Messages with sequence number at or above `fromSeq`, oldest first (one page). */
  async topicMessages(topicId: string, fromSeq: bigint, limit = 100): Promise<{ messages: TopicMessage[]; more: boolean }> {
    const body = await this.get<Page<RawMessage>>(
      `/api/v1/topics/${topicId}/messages?sequencenumber=gte:${fromSeq}&order=asc&limit=${limit}`,
    );
    if (body === null) return { messages: [], more: false };
    const messages = (body.messages ?? []).map(toMessage);
    return { messages, more: Boolean(body.links?.next) && messages.length > 0 };
  }

  /** One message by sequence number, or null when the mirror node has no such message. */
  async topicMessage(topicId: string, seq: bigint): Promise<TopicMessage | null> {
    const body = await this.get<RawMessage>(`/api/v1/topics/${topicId}/messages/${seq}`);
    return body === null ? null : toMessage(body);
  }

  /** The newest message on the topic, or null when the topic has none. */
  async newestTopicMessage(topicId: string): Promise<TopicMessage | null> {
    const body = await this.get<Page<RawMessage>>(`/api/v1/topics/${topicId}/messages?order=desc&limit=1`);
    const first = body?.messages?.[0];
    return first === undefined ? null : toMessage(first);
  }

  /** Account of the transaction id of the transaction at this consensus timestamp. */
  async transactionAccountAt(consensusTimestamp: string): Promise<string | null> {
    const body = await this.get<{ transactions?: { transaction_id?: string }[] }>(
      `/api/v1/transactions?timestamp=${consensusTimestamp}&limit=1`,
    );
    const id = body?.transactions?.[0]?.transaction_id;
    if (typeof id !== 'string') return null;
    const dash = id.indexOf('-');
    return dash > 0 ? id.slice(0, dash) : null;
  }

  /** End timestamp of the newest record file the mirror node has ingested. */
  async newestBlockTimestamp(): Promise<string> {
    const body = await this.get<{ blocks?: { timestamp?: { to?: string } }[] }>(`/api/v1/blocks?order=desc&limit=1`);
    const to = body?.blocks?.[0]?.timestamp?.to;
    if (typeof to !== 'string') throw new TransientError('mirror: no blocks');
    return to;
  }
}

export interface LogCursor {
  [key: string]: string;
  /** Highest consensus timestamp whose logs were all handed to the caller and committed. */
  timestamp: string;
}

export interface HederaLogReaderOptions {
  mirror: MirrorClient;
  /** EVM address or 0.0.N of the contract. */
  contract: string;
  /** State directory for the cursor file. */
  dir: string;
  /** Cursor name. */
  source: string;
  /** Where to start when no cursor exists (the deploy timestamp). */
  startTimestamp: string;
  /** Re-scan this many seconds behind the saved cursor on the first poll after start. */
  overlapS?: number;
  maxPages?: number;
}

function logKey(l: MirrorLog): string {
  return `${l.transactionHash}:${l.index}`;
}

/**
 * Reads one contract's logs from the mirror node with a saved cursor. The first poll after start
 * re-reads an overlap behind the cursor; callers must dedupe on (transaction hash, log index),
 * which `key` gives. `commit` saves the cursor once the caller has journaled the logs.
 */
export class HederaLogReader {
  private cursor: string;
  private first = true;
  private readonly seen = new Map<string, string>();
  private pendingTs: string | undefined;

  constructor(private readonly o: HederaLogReaderOptions) {
    const saved = loadCursor<LogCursor>(o.dir, o.source);
    this.cursor = saved?.timestamp ?? o.startTimestamp;
  }

  static key = logKey;

  get position(): string {
    return this.cursor;
  }

  /** New logs since the last commit, oldest first. */
  async poll(): Promise<{ logs: MirrorLog[]; complete: boolean }> {
    const from = this.first ? tsMinusSeconds(this.cursor, this.o.overlapS ?? 300) : this.cursor;
    const { logs, complete } = await this.o.mirror.contractLogsSince(this.o.contract, from, this.o.maxPages);
    this.first = false;
    const fresh = logs.filter((l) => !this.seen.has(logKey(l)));
    fresh.sort((a, b) => compareTs(a.timestamp, b.timestamp) || a.index - b.index);
    const last = logs[logs.length - 1];
    this.pendingTs = last?.timestamp;
    return { logs: fresh, complete };
  }

  /** Marks the logs of the last poll as handled and saves the cursor. */
  commit(handled: readonly MirrorLog[]): void {
    for (const l of handled) this.seen.set(logKey(l), l.timestamp);
    if (this.pendingTs !== undefined && compareTs(this.pendingTs, this.cursor) > 0) {
      this.cursor = this.pendingTs;
      saveCursor<LogCursor>(this.o.dir, this.o.source, { timestamp: this.cursor });
    }
    // Keep keys only near the cursor; the gte query re-returns logs at the cursor timestamp.
    const floor = tsMinusSeconds(this.cursor, (this.o.overlapS ?? 300) + 60);
    for (const [k, ts] of this.seen) if (compareTs(ts, floor) < 0) this.seen.delete(k);
    this.pendingTs = undefined;
  }
}
