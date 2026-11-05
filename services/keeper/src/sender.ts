// Journaled transaction sender. One serial queue per (chain, signer): at most one transaction of
// ours is open (signed and not yet resolved) per key, so nonces never collide with each other.
//
// Order for every send: simulate with eth_call (a revert is returned, nothing is sent), sign,
// journal the intent with the raw signed bytes, broadcast, wait briefly for the receipt, journal
// the result. After a restart, `resolveOpen` settles every intent without a result: a receipt
// gives the result; a transaction the node still knows is left to mine; a transaction the node
// does not know whose nonce is still unused is rebroadcast byte for byte; a nonce used by some
// other transaction marks the intent superseded, and the caller re-reads chain state.

import { keccak256, type Address, type Hex } from 'viem';
import type { JournalRecord } from './journal.js';
import { isTransient } from './net.js';

export type ChainName = 'hedera' | 'arbitrum';

export type FeeFields =
  | { type: 'legacy'; gasPrice: bigint }
  | { type: 'eip1559'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

export interface TxReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
}

/** A simulated or mined call reverted. `data` is the raw revert data when the node gave it. */
export class RevertError extends Error {
  constructor(
    readonly data: Hex | undefined,
    message = 'execution reverted',
  ) {
    super(message);
    this.name = 'RevertError';
  }
}

/** The JSON-RPC operations the sender needs, so tests can stand in for a node. */
export interface TxRpc {
  chainId: number;
  /** eth_call at latest; throws RevertError on a revert, TransientError on a transport failure. */
  call(tx: { from: Address; to: Address; data: Hex; value?: bigint }): Promise<void>;
  estimateGas(tx: { from: Address; to: Address; data: Hex; value?: bigint }): Promise<bigint>;
  fees(): Promise<FeeFields>;
  nonce(address: Address, tag: 'latest' | 'pending'): Promise<number>;
  sendRaw(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<TxReceipt | null>;
  /** True when the node knows the transaction (pending or mined). */
  known(hash: Hex): Promise<boolean>;
}

export interface TxSigner {
  address: Address;
  signTransaction(tx: Record<string, unknown>): Promise<Hex>;
}

export interface SendRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Name of the contract function, for the journal and logs. */
  call: string;
  claimId?: Hex;
  /** Fixed gas limit; otherwise estimated with headroom. */
  gas?: bigint;
}

export type SendOutcome =
  | { kind: 'mined'; id: string; hash: Hex; status: 'success' | 'reverted'; blockNumber: bigint; revertData?: Hex }
  | { kind: 'pending'; id: string; hash: Hex }
  | { kind: 'rejected'; revertData?: Hex; message: string }
  | { kind: 'busy' }
  | { kind: 'dry' };

export interface IntentRecord extends JournalRecord {
  t: 'intent';
  id: string;
  chain: ChainName;
  from: Address;
  to: Address;
  data: Hex;
  /** Wei as a decimal string. */
  value: string;
  call: string;
  claimId?: Hex;
  nonce: number;
  hash: Hex;
  raw: Hex;
}

export interface ResultRecord extends JournalRecord {
  t: 'result';
  id: string;
  chain: ChainName;
  hash: Hex;
  outcome: 'success' | 'reverted' | 'superseded';
  block?: string;
  revertData?: Hex;
}

export interface SenderOptions {
  chain: ChainName;
  rpc: TxRpc;
  /** Absent in dry-run mode: nothing is signed or sent. */
  signer?: TxSigner;
  /** Address used for simulation when no signer is loaded. */
  from: Address;
  append: (record: JournalRecord) => void;
  nonceTag?: 'latest' | 'pending';
  /** Multiply the gas estimate by this many basis points (default 13,000 = 1.3x). */
  gasHeadroomBps?: bigint;
  gasCap?: bigint;
  receiptWaitMs?: number;
  receiptPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with each intent before broadcast; tests use it to simulate a crash. */
  onIntent?: (intent: IntentRecord) => void;
  log?: (line: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let seq = 0;
function newIntentId(chain: ChainName): string {
  seq = (seq + 1) % 1_000_000;
  return `${chain}-${Date.now().toString(36)}-${process.pid.toString(36)}-${seq.toString(36)}`;
}

export class Sender {
  private readonly open = new Map<string, IntentRecord>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: SenderOptions) {}

  get chain(): ChainName {
    return this.o.chain;
  }

  get address(): Address {
    return this.o.signer?.address ?? this.o.from;
  }

  get dryRun(): boolean {
    return this.o.signer === undefined;
  }

  /** Loads intents and results of this chain and signer from a replayed journal. */
  load(records: readonly JournalRecord[]): void {
    const results = new Set<string>();
    for (const r of records) if (r.t === 'result' && r.chain === this.o.chain) results.add(String(r.id));
    for (const r of records) {
      if (r.t !== 'intent' || r.chain !== this.o.chain) continue;
      const intent = r as IntentRecord;
      if (intent.from.toLowerCase() !== this.address.toLowerCase()) continue;
      if (!results.has(intent.id)) this.open.set(intent.id, intent);
    }
  }

  /** Intents signed but not yet resolved. */
  openIntents(): IntentRecord[] {
    return [...this.open.values()];
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private result(intent: IntentRecord, outcome: ResultRecord['outcome'], extra: Partial<ResultRecord> = {}): void {
    const rec: ResultRecord = { t: 'result', id: intent.id, chain: this.o.chain, hash: intent.hash, outcome, ...extra };
    this.o.append(rec);
    this.open.delete(intent.id);
  }

  /** Simulates a call without sending it. Returns undefined when it would succeed. */
  async simulate(req: SendRequest): Promise<{ revertData?: Hex; message: string } | undefined> {
    try {
      await this.o.rpc.call({ from: this.address, to: req.to, data: req.data, value: req.value });
      return undefined;
    } catch (err) {
      if (err instanceof RevertError) return { revertData: err.data, message: err.message };
      throw err;
    }
  }

  /** Simulates, then signs, journals and sends. Never sends while another intent of ours is open. */
  send(req: SendRequest): Promise<SendOutcome> {
    return this.serial(async () => {
      if (this.open.size > 0) return { kind: 'busy' } as const;
      const sim = await this.simulate(req);
      if (sim !== undefined) return { kind: 'rejected', revertData: sim.revertData, message: sim.message } as const;
      if (this.o.signer === undefined) {
        this.o.log?.(`dry-run: would call ${req.call} on ${this.o.chain} ${req.to}${req.claimId ? ` for ${req.claimId}` : ''}`);
        return { kind: 'dry' } as const;
      }
      const from = this.o.signer.address;
      let gas = req.gas;
      if (gas === undefined) {
        const est = await this.o.rpc.estimateGas({ from, to: req.to, data: req.data, value: req.value });
        gas = (est * (this.o.gasHeadroomBps ?? 13_000n)) / 10_000n;
      }
      if (this.o.gasCap !== undefined && gas > this.o.gasCap) gas = this.o.gasCap;
      const tag = this.o.nonceTag ?? 'pending';
      const nonce = Math.max(await this.o.rpc.nonce(from, tag), await this.o.rpc.nonce(from, 'latest'));
      const fees = await this.o.rpc.fees();
      const tx: Record<string, unknown> = {
        chainId: this.o.rpc.chainId,
        nonce,
        to: req.to,
        data: req.data,
        value: req.value ?? 0n,
        gas,
        ...(fees.type === 'legacy'
          ? { type: 'legacy', gasPrice: fees.gasPrice }
          : { type: 'eip1559', maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }),
      };
      const raw = await this.o.signer.signTransaction(tx);
      const hash = keccak256(raw);
      const intent: IntentRecord = {
        t: 'intent',
        id: newIntentId(this.o.chain),
        chain: this.o.chain,
        from,
        to: req.to,
        data: req.data,
        value: (req.value ?? 0n).toString(),
        call: req.call,
        nonce,
        hash,
        raw,
        ...(req.claimId ? { claimId: req.claimId } : {}),
      };
      this.o.append(intent);
      this.open.set(intent.id, intent);
      this.o.onIntent?.(intent);
      try {
        await this.o.rpc.sendRaw(raw);
      } catch (err) {
        // The intent stays open; resolveOpen decides whether it landed, is pending or must be rebroadcast.
        this.o.log?.(`broadcast of ${req.call} failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: 'pending', id: intent.id, hash } as const;
      }
      return this.awaitReceipt(intent);
    });
  }

  private async awaitReceipt(intent: IntentRecord): Promise<SendOutcome> {
    const sleep = this.o.sleep ?? defaultSleep;
    const waitMs = this.o.receiptWaitMs ?? 20_000;
    const pollMs = this.o.receiptPollMs ?? 1_000;
    const deadline = Date.now() + waitMs;
    for (;;) {
      let rc: TxReceipt | null = null;
      try {
        rc = await this.o.rpc.receipt(intent.hash);
      } catch (err) {
        if (!isTransient(err)) throw err;
      }
      if (rc !== null) return this.settle(intent, rc);
      if (Date.now() >= deadline) return { kind: 'pending', id: intent.id, hash: intent.hash };
      await sleep(pollMs);
    }
  }

  private async settle(intent: IntentRecord, rc: TxReceipt): Promise<SendOutcome> {
    let revertData: Hex | undefined;
    if (rc.status === 'reverted') {
      // Re-run the call to learn why; the state may have moved, so this is a best guess.
      try {
        await this.o.rpc.call({ from: intent.from, to: intent.to, data: intent.data, value: BigInt(intent.value) });
      } catch (err) {
        if (err instanceof RevertError) revertData = err.data;
      }
    }
    this.result(intent, rc.status, { block: rc.blockNumber.toString(), ...(revertData ? { revertData } : {}) });
    return { kind: 'mined', id: intent.id, hash: intent.hash, status: rc.status, blockNumber: rc.blockNumber, revertData };
  }

  /**
   * Settles open intents (after a restart, a broadcast failure or a receipt timeout). Returns the
   * outcomes it reached; intents still in flight stay open.
   */
  resolveOpen(): Promise<{ intent: IntentRecord; outcome: SendOutcome | { kind: 'superseded'; id: string } }[]> {
    return this.serial(async () => {
      const done: { intent: IntentRecord; outcome: SendOutcome | { kind: 'superseded'; id: string } }[] = [];
      for (const intent of [...this.open.values()]) {
        const rc = await this.o.rpc.receipt(intent.hash);
        if (rc !== null) {
          done.push({ intent, outcome: await this.settle(intent, rc) });
          continue;
        }
        if (await this.o.rpc.known(intent.hash)) continue; // still pending
        const used = await this.o.rpc.nonce(intent.from, 'latest');
        if (used <= intent.nonce) {
          if (this.o.signer === undefined) continue; // dry run never broadcasts
          try {
            await this.o.rpc.sendRaw(intent.raw);
            this.o.append({ t: 'rebroadcast', id: intent.id, chain: this.o.chain, hash: intent.hash });
          } catch (err) {
            this.o.log?.(`rebroadcast of ${intent.call} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          continue;
        }
        // The nonce went to a different transaction (another tool signed with this key).
        this.result(intent, 'superseded');
        done.push({ intent, outcome: { kind: 'superseded', id: intent.id } });
      }
      return done;
    });
  }
}
