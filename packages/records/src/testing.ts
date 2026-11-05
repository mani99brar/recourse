// In-memory stand-ins for tests and local runs ONLY. Nothing here touches Hedera or IPFS: the
// "ledger" is a Map, its transaction ids are made up, and every submitter it hands out reports
// `simulated: true`, which the records client copies onto each commit. Never point a deployed
// service at these.

import { MirrorClient, type FetchLike } from './mirror.js';
import type { HcsSubmitter, PreparedMessage, ReceiptState } from './hcs.js';
import type { IpfsOptions, PinProvider } from './ipfs.js';
import { hashOfCid } from './car.js';
import { CarBufferReader } from '@ipld/car/buffer-reader';

const MEMORY_MIRROR_URL = 'http://memory-mirror.invalid';
const MEMORY_GATEWAY_URL = 'http://memory-gateway.invalid';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface MemoryMessage {
  seq: number;
  consensusAt: string;
  payer: string;
  bytes: Uint8Array;
  chunkTotal?: number;
}

interface MemoryTx {
  txId: string;
  payer: string;
  result: string;
  consensusAt: string;
  name: string;
  seq?: number;
}

/**
 * What a simulated submission does when `send` is called:
 * - `ok`: lands and returns its sequence number;
 * - `drop`: never lands, `send` throws;
 * - `lost_reply`: lands, but `send` throws as if the reply were lost on the way back;
 * - `hang`: never lands and never returns (a process killed mid-send);
 * - `land_and_hang`: lands, then never returns (killed before the reply was handled).
 */
export type SendFault = 'ok' | 'drop' | 'lost_reply' | 'hang' | 'land_and_hang';

export interface MemorySubmitterOptions {
  /** Faults for the next sends, in order; `ok` once the list is used up. */
  faults?: SendFault[];
  /** When false, `receipt` always answers `unknown` (receipts expire after a few minutes on Hedera). */
  receipts?: boolean;
}

/** A simulated HCS network plus the mirror node REST view of it. Test and local use only. */
export class MemoryLedger {
  readonly simulated = true;
  private readonly topics = new Map<string, MemoryMessage[]>();
  private readonly txs = new Map<string, MemoryTx>();
  private nanos = 0;
  /** Unix seconds; tests move it forward to expire transactions. */
  clock: number;
  /** Count of mirror requests answered, by path prefix, for assertions. */
  readonly mirrorHits = { messages: 0, transactions: 0, topics: 0 };

  constructor(start = 1_800_000_000) {
    this.clock = start;
  }

  createTopic(topicId: string): void {
    if (!this.topics.has(topicId)) this.topics.set(topicId, []);
  }

  messages(topicId: string): readonly MemoryMessage[] {
    return this.topics.get(topicId) ?? [];
  }

  private stamp(): string {
    this.nanos += 1;
    return `${this.clock}.${String(this.nanos).padStart(9, '0')}`;
  }

  /** Appends a message as `payer` directly, for writing foreign or malformed messages in tests. */
  append(topicId: string, payer: string, bytes: Uint8Array, chunkTotal?: number): number {
    const list = this.topics.get(topicId);
    if (!list) throw new Error(`memory ledger: no topic ${topicId}`);
    const seq = list.length + 1;
    list.push({ seq, consensusAt: this.stamp(), payer, bytes: new Uint8Array(bytes), chunkTotal });
    return seq;
  }

  submitter(payer: string, options: MemorySubmitterOptions = {}): MemorySubmitter {
    return new MemorySubmitter(this, payer, options);
  }

  private txCounter = 0;

  /** @internal Unique nanos part for simulated transaction ids. */
  nextTxNanos(): number {
    this.txCounter += 1;
    return this.txCounter;
  }

  /** @internal */
  land(txId: string, payer: string, topicId: string, bytes: Uint8Array): number {
    const seq = this.append(topicId, payer, bytes);
    const consensusAt = this.messages(topicId)[seq - 1]!.consensusAt;
    this.txs.set(txId, { txId, payer, result: 'SUCCESS', consensusAt, name: 'CONSENSUSSUBMITMESSAGE', seq });
    return seq;
  }

  /** @internal */
  tx(txId: string): MemoryTx | undefined {
    return this.txs.get(txId);
  }

  /** Mirror node REST for the paths the records client reads. */
  readonly fetch: FetchLike = async (input) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    let m = /^\/topics\/([^/]+)\/messages$/.exec(path);
    if (m) {
      this.mirrorHits.messages += 1;
      const topicId = decodeURIComponent(m[1]!);
      const list = this.topics.get(topicId);
      if (!list) return json(404, { _status: { messages: [{ message: 'Not found' }] } });
      const from = Number((url.searchParams.get('sequencenumber') ?? 'gte:1').replace(/^gte:/, ''));
      const limit = Number(url.searchParams.get('limit') ?? '25');
      const page = list.filter((x) => x.seq >= from).slice(0, limit);
      return json(200, {
        messages: page.map((x) => ({
          sequence_number: x.seq,
          consensus_timestamp: x.consensusAt,
          payer_account_id: x.payer,
          topic_id: topicId,
          message: Buffer.from(x.bytes).toString('base64'),
          chunk_info: x.chunkTotal ? { number: 1, total: x.chunkTotal } : null,
        })),
        links: { next: null },
      });
    }
    m = /^\/topics\/([^/]+)$/.exec(path);
    if (m) {
      this.mirrorHits.topics += 1;
      const topicId = decodeURIComponent(m[1]!);
      if (!this.topics.has(topicId)) return json(404, {});
      return json(200, { topic_id: topicId, memo: 'memory', admin_key: null, submit_key: null, deleted: false });
    }
    m = /^\/transactions\/(\d+\.\d+\.\d+)-(\d+)-(\d+)$/.exec(path);
    if (m) {
      this.mirrorHits.transactions += 1;
      const txId = `${m[1]}@${m[2]}.${m[3]}`;
      const tx = this.txs.get(txId);
      if (!tx) return json(404, {});
      return json(200, {
        transactions: [
          {
            transaction_id: `${m[1]}-${m[2]}-${m[3]}`,
            result: tx.result,
            consensus_timestamp: tx.consensusAt,
            name: tx.name,
            nonce: 0,
            scheduled: false,
            transfers: [],
            token_transfers: [],
          },
        ],
      });
    }
    return json(404, {});
  };

  mirror(): MirrorClient {
    return new MirrorClient(MEMORY_MIRROR_URL, this.fetch);
  }
}

/** Simulated HCS submitter paying from `payer`. Test and local use only. */
export class MemorySubmitter implements HcsSubmitter {
  readonly simulated = true;
  private readonly faults: SendFault[];
  /** Every transaction id this submitter prepared, in order. */
  readonly prepared: string[] = [];
  /** Number of send calls, including retries of the same transaction. */
  sends = 0;
  private hungResolve!: () => void;
  /** Resolves when a `hang` or `land_and_hang` fault fires: the caller can treat the process as killed. */
  readonly hung: Promise<void> = new Promise((resolve) => {
    this.hungResolve = resolve;
  });

  constructor(
    private readonly ledger: MemoryLedger,
    readonly payer: string,
    private readonly options: MemorySubmitterOptions,
  ) {
    this.faults = [...(options.faults ?? [])];
  }

  /** Queues faults for the next sends. */
  inject(...faults: SendFault[]): void {
    this.faults.push(...faults);
  }

  async prepare(topicId: string, message: Uint8Array): Promise<PreparedMessage> {
    const validStart = this.ledger.clock;
    const txId = `${this.payer}@${validStart}.${String(this.ledger.nextTxNanos()).padStart(9, '0')}`;
    this.prepared.push(txId);
    const bytes = new Uint8Array(message);
    return {
      txId,
      validStart,
      validSeconds: 120,
      send: async () => {
        this.sends += 1;
        const fault = this.faults.shift() ?? 'ok';
        if (fault === 'drop') throw new Error('memory submitter: simulated network failure');
        if (fault === 'hang') return this.hang();
        const landed = this.ledger.tx(txId);
        // Same signed transaction again: the ledger keeps the first copy only.
        const seq = landed?.seq ?? this.landOrExpire(txId, validStart, topicId, bytes);
        if (fault === 'lost_reply') throw new Error('memory submitter: simulated lost reply');
        if (fault === 'land_and_hang') return this.hang();
        return { seq };
      },
    };
  }

  private hang(): Promise<never> {
    this.hungResolve();
    return new Promise<never>(() => {});
  }

  private landOrExpire(txId: string, validStart: number, topicId: string, bytes: Uint8Array): number {
    if (this.ledger.clock > validStart + 120) throw new Error('memory submitter: TRANSACTION_EXPIRED');
    return this.ledger.land(txId, this.payer, topicId, bytes);
  }

  async receipt(txId: string): Promise<ReceiptState> {
    if (this.options.receipts === false) return { state: 'unknown' };
    const tx = this.ledger.tx(txId);
    if (!tx) return { state: 'unknown' };
    return tx.result === 'SUCCESS' && tx.seq !== undefined ? { state: 'success', seq: tx.seq } : { state: 'failed', status: tx.result };
  }

  close(): void {}
}

export type PinFault = 'ok' | 'fail' | 'wrong_cid' | 'corrupt';

/** Simulated IPFS pinning service plus gateway. Test and local use only. */
export class MemoryIpfs {
  readonly simulated = true;
  private readonly blocks = new Map<string, Uint8Array>();
  private readonly faults: PinFault[] = [];
  pinCalls = 0;
  gatewayCalls = 0;

  inject(...faults: PinFault[]): void {
    this.faults.push(...faults);
  }

  has(cid: string): boolean {
    return this.blocks.has(cid);
  }

  /** Stores bytes under a CID directly, for fetch tests. */
  put(cid: string, bytes: Uint8Array): void {
    this.blocks.set(cid, new Uint8Array(bytes));
  }

  readonly provider: PinProvider = {
    name: 'memory',
    pinCar: async (car: Uint8Array, rootCid: string) => {
      this.pinCalls += 1;
      const fault = this.faults.shift() ?? 'ok';
      if (fault === 'fail') throw new Error('memory pin: simulated provider failure');
      const reader = CarBufferReader.fromBytes(car);
      const roots = reader.getRoots();
      if (roots.length !== 1 || roots[0]!.toString() !== rootCid) throw new Error('memory pin: CAR root mismatch');
      for (const block of reader.blocks()) {
        const bytes = fault === 'corrupt' ? new Uint8Array([...block.bytes, 0x20]) : block.bytes;
        this.blocks.set(block.cid.toString(), new Uint8Array(bytes));
      }
      if (fault === 'wrong_cid') return { cid: 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
      return { cid: rootCid };
    },
  };

  readonly fetch: FetchLike = async (input) => {
    this.gatewayCalls += 1;
    const m = /\/ipfs\/([^/?]+)/.exec(new URL(input).pathname);
    const bytes = m ? this.blocks.get(m[1]!) : undefined;
    if (!bytes) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { 'content-length': String(bytes.length) } });
  };

  options(overrides: Partial<IpfsOptions> = {}): IpfsOptions {
    return { gatewayUrl: MEMORY_GATEWAY_URL, fetchImpl: this.fetch, retries: 0, backoffMs: () => 0, timeoutMs: 1000, ...overrides };
  }

  /** The hash a stored CID carries, for assertions. */
  static hashOf(cid: string) {
    return hashOfCid(cid);
  }
}
