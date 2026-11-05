// Where events come from. The mirror-node source reads contract logs by consensus-timestamp
// cursor; the Arbitrum source reads `CaseOpened` in block chunks of at most 1,000. Neither reads
// Arkiv: the chain logs are the source of truth.

import { decodeDocketLog, type DocketEvent } from './events.js';

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
  /** Consensus timestamp of the last log read, `seconds.nanos`; unchanged when nothing new. */
  cursor: string | undefined;
}

function compareTs(a: string, b: string): number {
  const [as = '0', an = '0'] = a.split('.');
  const [bs = '0', bn = '0'] = b.split('.');
  if (as !== bs) return Number(as) - Number(bs);
  return Number(an.padEnd(9, '0')) - Number(bn.padEnd(9, '0'));
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
    let last = cursor;
    let next: string | null = `/api/v1/contracts/${this.opts.contract}/results/logs?order=asc&limit=${limit}${cursor ? `&timestamp=gt:${cursor}` : ''}`;
    for (let page = 0; next !== null && page < maxPages; page++) {
      const res: Response = await this.fetcher(`${root}${next}`);
      if (!res.ok) throw new Error(`mirror node answered ${res.status}`);
      const body = (await res.json()) as { logs?: MirrorLog[]; links?: { next?: string | null } };
      const logs = body.logs ?? [];
      for (const log of logs) {
        if (last !== undefined && compareTs(log.timestamp, last) <= 0) continue;
        const ev = decodeDocketLog('hedera', { tx: log.transaction_hash, index: log.index, ts: Math.floor(Number(log.timestamp.split('.')[0])) }, log);
        if (ev !== null) events.push(ev);
        last = log.timestamp;
      }
      next = body.links?.next ?? null;
      if (logs.length === 0) break;
    }
    return { events, cursor: last };
  }
}

/** The reads the Arbitrum source needs; viem's public client fits this. */
export interface ArbReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }): Promise<{ topics: readonly string[]; data: string; transactionHash: string; logIndex: number; blockNumber: bigint }[]>;
}

export class ArbitrumCaseSource {
  readonly name = 'arbitrum';

  constructor(
    private readonly reader: ArbReader,
    private readonly address: `0x${string}`,
    private readonly startBlock: bigint,
    private readonly chunk = 1000n,
    private readonly maxChunks = 20,
  ) {
    if (chunk < 1n || chunk > 1000n) throw new RangeError('chunk must be 1-1000 blocks');
  }

  /** Cursor is the last block fully read. */
  async poll(cursor: string | undefined): Promise<PollResult> {
    const head = await this.reader.getBlockNumber();
    let from = cursor === undefined ? this.startBlock : BigInt(cursor) + 1n;
    const events: DocketEvent[] = [];
    let done = cursor;
    for (let i = 0; i < this.maxChunks && from <= head; i++) {
      const to = from + this.chunk - 1n < head ? from + this.chunk - 1n : head;
      const logs = await this.reader.getLogs({ address: this.address, fromBlock: from, toBlock: to });
      for (const log of logs) {
        // Block timestamps are not fetched: CaseOpened only supplies a dispute id.
        const ev = decodeDocketLog('arbitrum', { tx: log.transactionHash, index: log.logIndex, ts: 0 }, log);
        if (ev !== null) events.push(ev);
      }
      done = to.toString();
      from = to + 1n;
    }
    return { events, cursor: done };
  }
}
