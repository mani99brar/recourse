// Event sources. Arbitrum (and a local Hedera anvil) are read with eth_getLogs in block chunks up
// to `latest - confirmations`, with a saved cursor; Hedera testnet is read from the mirror node.
// Every source returns decoded ChainEvents and saves its cursor only on commit, after the caller
// has journaled the events, so a crash re-reads at most one range (the book drops repeats).

import { decodeEventLog, type Abi, type Address, type Hex, type Log, type PublicClient } from 'viem';
import { loadCursor, saveCursor } from './cursor.js';
import type { MirrorLog } from './mirror.js';
import { HederaLogReader } from './mirror.js';
import { tsSeconds } from './timestamps.js';
import type { Chain, ChainEvent } from './types.js';

export interface EventSource {
  poll(): Promise<ChainEvent[]>;
  commit(events: readonly ChainEvent[]): void;
  /** Seconds the source trails the chain head, when it can tell. */
  lagS?(): Promise<number>;
}

/** Decodes one raw log against an ABI; undefined for a log the ABI does not describe. */
export function decodeLog(abi: Abi, data: Hex, topics: readonly Hex[]): { name: string; args: Record<string, unknown> } | undefined {
  if (topics.length === 0) return undefined;
  try {
    const d = decodeEventLog({ abi, data, topics: topics as [Hex, ...Hex[]], strict: true });
    return { name: String(d.eventName), args: (d.args ?? {}) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ mirror node (Hedera testnet)

export class MirrorEventSource implements EventSource {
  private last: MirrorLog[] = [];

  constructor(
    private readonly reader: HederaLogReader,
    private readonly abi: Abi,
    private readonly source: string,
    private readonly lag?: () => Promise<number>,
  ) {}

  async poll(): Promise<ChainEvent[]> {
    const { logs } = await this.reader.poll();
    this.last = logs;
    const out: ChainEvent[] = [];
    for (const l of logs) {
      const d = decodeLog(this.abi, l.data, l.topics);
      if (!d) continue;
      out.push({
        chain: 'hedera',
        source: this.source,
        name: d.name,
        args: d.args,
        tx: l.transactionHash,
        logIndex: l.index,
        time: Number(tsSeconds(l.timestamp)),
        position: `${l.timestamp}#${l.index}`,
      });
    }
    return out;
  }

  commit(_events?: readonly ChainEvent[]): void {
    this.reader.commit(this.last);
    this.last = [];
  }

  async lagS(): Promise<number> {
    return this.lag ? this.lag() : 0;
  }
}

// ------------------------------------------------------------------ eth_getLogs (Arbitrum, local)

export interface LogQuery {
  /** Contract name for ChainEvent.source. */
  source: string;
  address: Address;
  abi: Abi;
  /** One event of the ABI to read, with optional indexed-argument filters (OR lists). */
  eventName?: string;
  args?: Record<string, unknown>;
}

export interface BlockLogReaderOptions {
  chain: Chain;
  client: PublicClient;
  dir: string;
  /** Cursor name. */
  source: string;
  /** First block to read when no cursor exists (the deploy block). */
  startBlock: number;
  /** Read up to `latest - confirmations`. */
  confirmations: number;
  /** Blocks per eth_getLogs call. */
  chunk: number;
  /** Chunks per poll (catching up from the deploy block). */
  maxChunks: number;
  /** Queries run on every block range, before the poll's `then` queries. */
  first: LogQuery[];
}

export interface PollHooks {
  /** Sees each range's `first` events before `then` is asked for its queries. */
  between?: (events: readonly ChainEvent[]) => void;
  /** Queries narrowed by what `between` learned (new dispute ids). */
  then?: () => LogQuery[];
}

interface BlockCursor {
  [key: string]: number;
  /** Next block to read. */
  next: number;
}

export class BlockLogReader implements EventSource {
  private next: number;
  private pendingNext: number | undefined;
  private readonly times = new Map<bigint, number>();

  constructor(private readonly o: BlockLogReaderOptions) {
    this.next = loadCursor<BlockCursor>(o.dir, o.source)?.next ?? o.startBlock;
  }

  get position(): number {
    return this.next;
  }

  async head(): Promise<number> {
    const latest = Number(await this.o.client.getBlockNumber({ cacheTime: 0 }));
    return Math.max(0, latest - this.o.confirmations);
  }

  async poll(hooks: PollHooks = {}): Promise<ChainEvent[]> {
    const head = await this.head();
    let from = this.next;
    const out: ChainEvent[] = [];
    for (let i = 0; i < this.o.maxChunks && from <= head; i++) {
      const to = Math.min(head, from + this.o.chunk - 1);
      const firstEvents = await this.read(this.o.first, from, to);
      hooks.between?.(firstEvents);
      const thenEvents = hooks.then ? await this.read(hooks.then(), from, to) : [];
      out.push(...firstEvents, ...thenEvents);
      from = to + 1;
    }
    this.pendingNext = from;
    out.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    return out;
  }

  commit(_events?: readonly ChainEvent[]): void {
    if (this.pendingNext !== undefined && this.pendingNext > this.next) {
      this.next = this.pendingNext;
      saveCursor<BlockCursor>(this.o.dir, this.o.source, { next: this.next });
    }
    this.pendingNext = undefined;
  }

  async lagS(): Promise<number> {
    const latest = await this.o.client.getBlock({ blockTag: 'latest' });
    if (this.next === 0) return 0;
    const at = await this.blockTime(BigInt(Math.max(0, this.next - 1)));
    return Math.max(0, Number(latest.timestamp) - at);
  }

  private async read(queries: readonly LogQuery[], from: number, to: number): Promise<ChainEvent[]> {
    const out: ChainEvent[] = [];
    for (const q of queries) {
      if (q.args && Object.values(q.args).some((v) => Array.isArray(v) && v.length === 0)) continue; // nothing to match
      const event = q.eventName ? (q.abi.find((x) => x.type === 'event' && x.name === q.eventName) as never) : undefined;
      const logs: Log[] = await this.o.client.getLogs({
        address: q.address,
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
        ...(event ? { event, ...(q.args ? { args: q.args as never } : {}) } : {}),
      } as never);
      for (const l of logs) {
        if (l.removed || l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
        const d = decodeLog(q.abi, l.data, l.topics as Hex[]);
        if (!d) continue;
        const time = await this.blockTime(l.blockNumber);
        out.push({
          chain: this.o.chain,
          source: q.source,
          name: d.name,
          args: d.args,
          tx: l.transactionHash,
          logIndex: l.logIndex,
          time,
          position: `${l.blockNumber.toString().padStart(12, '0')}#${l.logIndex.toString().padStart(6, '0')}`,
        });
      }
    }
    return out;
  }

  private async blockTime(n: bigint): Promise<number> {
    const hit = this.times.get(n);
    if (hit !== undefined) return hit;
    const b = await this.o.client.getBlock({ blockNumber: n });
    const t = Number(b.timestamp);
    if (this.times.size > 5000) this.times.clear();
    this.times.set(n, t);
    return t;
  }
}
