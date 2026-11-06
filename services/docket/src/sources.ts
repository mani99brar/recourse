// Where events come from. The mirror-node source reads contract logs by a (consensus timestamp,
// log index) cursor; the Arbitrum source reads `CaseOpened` in block chunks of at most 1,000. Neither reads
// Arkiv: the chain logs are the source of truth.

import { decodeDocketLog, type Chain, type DocketEvent } from './events.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MirrorLogSourceOptions {
  baseUrl: string;
  /** Contract address (0x...) or id (0.0.N) to read. */
  contract: string;
  /** Cursor key under which the position is kept. */
  name: string;
  fetch?: FetchLike;
  pageLimit?: number;
  /** Stop a poll after this many pages so a long backlog cannot starve the writer. */
  maxPages?: number;
  /** Published ABI; the built-in fragments are the fallback. */
  abi?: readonly unknown[];
  /** Where the first poll starts, "secs.nanos". */
  initialCursor?: string;
}

interface MirrorLog {
  topics: string[];
  data: string;
  index: number;
  timestamp: string;
  transaction_hash: string;
}

export interface PollResult {
  events: DocketEvent[];
  /**
   * Where the next poll resumes; unchanged when nothing new. For the mirror source it is the last
   * log read, `seconds.nanos#index`.
   */
  cursor: string | undefined;
}

function compareTs(a: string, b: string): number {
  const [as = '0', an = '0'] = a.split('.');
  const [bs = '0', bn = '0'] = b.split('.');
  if (as !== bs) return Number(as) - Number(bs);
  return Number(an.padEnd(9, '0')) - Number(bn.padEnd(9, '0'));
}

interface LogPosition {
  timestamp: string;
  index: number;
}

/**
 * Reads a mirror cursor. A bare timestamp (the deploy start, or a cursor journaled before the
 * cursor named the log index) names no log at that timestamp as read, so the poll reads that
 * timestamp again; the docket drops the logs it has already seen.
 */
function parseCursor(cursor: string): LogPosition {
  const [timestamp = cursor, index] = cursor.split('#');
  return { timestamp, index: index === undefined ? -1 : Number(index) };
}

/** All logs of one transaction share its consensus timestamp, so a log's place is (timestamp, index). */
function isAfter(log: LogPosition, at: LogPosition): boolean {
  const byTs = compareTs(log.timestamp, at.timestamp);
  return byTs > 0 || (byTs === 0 && log.index > at.index);
}

export class MirrorLogSource {
  readonly name: string;
  private readonly fetcher: FetchLike;

  constructor(private readonly opts: MirrorLogSourceOptions) {
    this.name = opts.name;
    this.fetcher = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async poll(cursor: string | undefined): Promise<PollResult> {
    const root = this.opts.baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    const limit = this.opts.pageLimit ?? 100;
    const maxPages = this.opts.maxPages ?? 20;
    const events: DocketEvent[] = [];
    cursor = cursor ?? this.opts.initialCursor;
    let last = cursor === undefined ? undefined : parseCursor(cursor);
    // From the cursor's timestamp inclusive: the rest of a transaction cut off by a page or poll
    // boundary carries the same timestamp.
    let next: string | null = `/api/v1/contracts/${this.opts.contract}/results/logs?order=asc&limit=${limit}${last ? `&timestamp=gte:${last.timestamp}` : ''}`;
    for (let page = 0; next !== null && page < maxPages; page++) {
      const res: Response = await this.fetcher(`${root}${next}`);
      if (!res.ok) throw new Error(`mirror node answered ${res.status}`);
      const body = (await res.json()) as { logs?: MirrorLog[]; links?: { next?: string | null } };
      const logs = body.logs ?? [];
      for (const log of logs) {
        if (last !== undefined && !isAfter(log, last)) continue;
        const ev = decodeDocketLog('hedera', { tx: log.transaction_hash, index: log.index, ts: Math.floor(Number(log.timestamp.split('.')[0])) }, log, this.opts.abi);
        if (ev !== null) events.push(ev);
        last = { timestamp: log.timestamp, index: log.index };
      }
      next = body.links?.next ?? null;
      if (logs.length === 0) break;
    }
    return { events, cursor: last === undefined || last.index < 0 ? cursor : `${last.timestamp}#${last.index}` };
  }
}

/** The reads a block-range source needs; viem's public client fits this. */
export interface ArbReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }): Promise<{ topics: readonly string[]; data: string; transactionHash: string; logIndex: number; blockNumber: bigint }[]>;
  /** Block time in unix seconds; optional, events carry 0 without it. */
  getBlockTimestamp?(block: bigint): Promise<number>;
}

export interface RpcLogSourceOptions {
  chain: Chain;
  name: string;
  address: `0x${string}`;
  startBlock: bigint;
  chunk?: bigint;
  maxChunks?: number;
  abi?: readonly unknown[];
}

/**
 * Reads one contract's logs over `eth_getLogs` in block chunks of at most 1,000. Used for
 * Arbitrum and for a local chain. The cursor is the last block fully read.
 */
export class RpcLogSource {
  readonly name: string;
  private readonly chunk: bigint;
  private readonly maxChunks: number;

  constructor(
    private readonly reader: ArbReader,
    private readonly o: RpcLogSourceOptions,
  ) {
    this.name = o.name;
    this.chunk = o.chunk ?? 1000n;
    this.maxChunks = o.maxChunks ?? 20;
    if (this.chunk < 1n || this.chunk > 1000n) throw new RangeError('chunk must be 1-1000 blocks');
  }

  async poll(cursor: string | undefined): Promise<PollResult> {
    const head = await this.reader.getBlockNumber();
    let from = cursor === undefined ? this.o.startBlock : BigInt(cursor) + 1n;
    const events: DocketEvent[] = [];
    const times = new Map<bigint, number>();
    let done = cursor;
    for (let i = 0; i < this.maxChunks && from <= head; i++) {
      const to = from + this.chunk - 1n < head ? from + this.chunk - 1n : head;
      const logs = await this.reader.getLogs({ address: this.o.address, fromBlock: from, toBlock: to });
      for (const log of logs) {
        let ts = 0;
        if (this.reader.getBlockTimestamp) {
          if (!times.has(log.blockNumber)) times.set(log.blockNumber, await this.reader.getBlockTimestamp(log.blockNumber));
          ts = times.get(log.blockNumber)!;
        }
        const ev = decodeDocketLog(this.o.chain, { tx: log.transactionHash, index: log.logIndex, ts }, log, this.o.abi);
        if (ev !== null) events.push(ev);
      }
      done = to.toString();
      from = to + 1n;
    }
    return { events, cursor: done };
  }
}

/** The case contract on Arbitrum: only `CaseOpened`, for dispute ids. */
export class ArbitrumCaseSource extends RpcLogSource {
  constructor(reader: ArbReader, address: `0x${string}`, startBlock: bigint, chunk = 1000n, maxChunks = 20, abi?: readonly unknown[]) {
    super(reader, { chain: 'arbitrum', name: 'arbitrum', address, startBlock, chunk, maxChunks, ...(abi ? { abi } : {}) });
  }
}
