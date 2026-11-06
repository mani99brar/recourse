// Journaled transaction sender. One serial queue per (chain, signer): at most one transaction of
// ours is open (signed and not yet resolved) per key, so nonces never collide with each other.
//
// Order for every send: simulate with eth_call (a revert is returned, nothing is sent), sign,
// journal the intent with the raw signed bytes, broadcast, wait briefly for the receipt, journal
// the result. After a restart, `resolveOpen` settles every intent without a result: a receipt
// gives the result; a transaction the node still knows is left to mine; a transaction the node
// does not know whose nonce is still unused is rebroadcast byte for byte; a nonce used by some
// other transaction marks the intent superseded, and the caller re-reads chain state.
//
// A node can also refuse the stored bytes for good: the key cannot pay, or the fees signed in
// them are now below the network's. With `dropRejected` set, an intent the node has refused that
// many times (and that is old enough, unknown to the node, with its nonce still unused) is
// journaled as dropped and the key is free again, so the caller re-reads the chain and signs a
// fresh transaction with fresh fees. After a drop for lack of funds the sender waits a while
// before it signs anything new on that key.

import { keccak256, type Address, type Hex } from 'viem';
import type { JournalRecord } from './journal.js';
import { isTransient } from './net.js';

/** Why a node refused a signed transaction outright (not a transport failure). */
export type RejectionReason = 'funds' | 'fee' | 'nonce' | 'other';

/** The node refused the signed transaction; resending the same bytes will not help. */
export class BroadcastRejected extends Error {
  constructor(
    readonly reason: RejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'BroadcastRejected';
  }
}

const REJECTIONS: readonly [RejectionReason, RegExp][] = [
  ['funds', /insufficient funds|insufficient balance|INSUFFICIENT_PAYER_BALANCE|INSUFFICIENT_ACCOUNT_BALANCE|exceeds balance/i],
  ['fee', /base fee|fee cap|underpriced|INSUFFICIENT_TX_FEE|max fee per gas|gas price[^.]*?(too low|below|less than)|intrinsic gas too low/i],
  ['nonce', /nonce too low|nonce has already been used|NONCE_TOO_LOW|nonce too high/i],
];

/** A broadcast the node says it already has: not a failure. */
export const ALREADY_KNOWN = /already known|known transaction|ALREADY_EXISTS|DUPLICATE_TRANSACTION|already imported/i;

/** The reason a node refused a broadcast, from the error or its text; undefined for transport failures. */
export function rejectionReason(err: unknown): RejectionReason | undefined {
  if (err instanceof BroadcastRejected) return err.reason;
  if (isTransient(err)) return undefined;
  const text = err instanceof Error ? err.message : String(err);
  for (const [reason, re] of REJECTIONS) if (re.test(text)) return reason;
  return undefined;
}

/** Classifies the full text of a node error (message, details and causes) as a rejection. */
export function rejectionOfText(text: string): RejectionReason | undefined {
  for (const [reason, re] of REJECTIONS) if (re.test(text)) return reason;
  return undefined;
}

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
  /** Lowest gas limit to send with when estimating (measured execution gas of the call). */
  gasFloor?: bigint;
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
  /** `dropped`: the node refused the bytes for good and the key was freed (only with `dropRejected`). */
  outcome: 'success' | 'reverted' | 'superseded' | 'dropped';
  block?: string;
  revertData?: Hex;
  /** Why it was dropped, and the node's last answer. */
  reason?: RejectionReason;
  error?: string;
}

/** An open intent as /health and the alerts see it. */
export interface IntentStatus {
  id: string;
  chain: ChainName;
  call: string;
  claimId?: Hex;
  hash: Hex;
  nonce: number;
  /** Seconds since the intent was journaled. */
  ageS: number;
  /** Broadcasts the node refused outright, in a row. */
  rejections: number;
  reason?: RejectionReason;
  /** The node's or the transport's last error for this intent. */
  lastError?: string;
}

export type ResolveOutcome = SendOutcome | { kind: 'superseded'; id: string } | { kind: 'dropped'; id: string; reason: RejectionReason };

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
  /**
   * Drop an intent the node keeps refusing: after `after` refusals in a row, once the intent is at
   * least `minAgeMs` old. After a drop for lack of funds, `send` answers busy for `fundsCooldownMs`
   * (doubling with each such drop in a row, up to 8x). Absent: intents are never dropped.
   */
  dropRejected?: { after: number; minAgeMs: number; fundsCooldownMs: number };
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let seq = 0;
function newIntentId(chain: ChainName): string {
  seq = (seq + 1) % 1_000_000;
  return `${chain}-${Date.now().toString(36)}-${process.pid.toString(36)}-${seq.toString(36)}`;
}

export class Sender {
  private readonly open = new Map<string, IntentRecord>();
  /** Per open intent: refusals in a row and the last error (memory only). */
  private readonly trouble = new Map<string, { rejections: number; reason?: RejectionReason; lastError: string }>();
  private cooldownUntilMs = 0;
  private fundsDrops = 0;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: SenderOptions) {}

  private nowMs(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Unix ms until which `send` answers busy after a drop for lack of funds; 0 when none. */
  get cooldownUntil(): number {
    return this.cooldownUntilMs;
  }

  /** Open intents with their age and broadcast trouble, for /health and alerts. */
  intentStatus(): IntentStatus[] {
    const now = this.nowMs();
    return [...this.open.values()].map((i) => {
      const t = this.trouble.get(i.id);
      return {
        id: i.id,
        chain: i.chain,
        call: i.call,
        ...(i.claimId ? { claimId: i.claimId } : {}),
        hash: i.hash,
        nonce: i.nonce,
        ageS: typeof i.at === 'number' ? Math.max(0, Math.floor((now - i.at) / 1000)) : 0,
        rejections: t?.rejections ?? 0,
        ...(t?.reason ? { reason: t.reason } : {}),
        ...(t ? { lastError: t.lastError } : {}),
      };
    });
  }

  /** Notes a failed broadcast of an intent; returns the refusal reason when the node refused it. */
  private broadcastFailed(intent: IntentRecord, err: unknown, what: string): RejectionReason | undefined {
    const message = err instanceof Error ? err.message : String(err);
    const reason = rejectionReason(err);
    const prev = this.trouble.get(intent.id);
    this.trouble.set(intent.id, {
      rejections: reason === undefined ? (prev?.rejections ?? 0) : (prev?.rejections ?? 0) + 1,
      ...(reason !== undefined ? { reason } : prev?.reason ? { reason: prev.reason } : {}),
      lastError: message.split('\n')[0]!,
    });
    this.o.log?.(`${what} of ${intent.call} failed${reason ? ` (node refused: ${reason})` : ''}: ${message.split('\n')[0]}`);
    return reason;
  }

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
    for (const r of records) this.loadRecord(r);
  }

  /** One replayed record; a result always follows its intent in the journal. */
  loadRecord(r: JournalRecord): void {
    if (r.chain !== this.o.chain) return;
    if (r.t === 'result') {
      this.open.delete(String(r.id));
      return;
    }
    if (r.t !== 'intent') return;
    const intent = r as IntentRecord;
    if (intent.from.toLowerCase() !== this.address.toLowerCase()) return;
    this.open.set(intent.id, intent);
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
    this.trouble.delete(intent.id);
    if (outcome === 'success' || outcome === 'reverted') this.fundsDrops = 0;
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
      if (this.nowMs() < this.cooldownUntilMs) return { kind: 'busy' } as const;
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
        if (req.gasFloor !== undefined && gas < req.gasFloor) gas = req.gasFloor;
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
        at: this.nowMs(),
      };
      this.o.append(intent);
      this.open.set(intent.id, intent);
      this.o.onIntent?.(intent);
      try {
        await this.o.rpc.sendRaw(raw);
      } catch (err) {
        // The intent stays open; resolveOpen decides whether it landed, is pending or must be rebroadcast.
        this.broadcastFailed(intent, err, 'broadcast');
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
  resolveOpen(opts: { rebroadcast?: (intent: IntentRecord) => boolean } = {}): Promise<{ intent: IntentRecord; outcome: ResolveOutcome }[]> {
    return this.serial(async () => {
      const done: { intent: IntentRecord; outcome: ResolveOutcome }[] = [];
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
          // Paused, or inside a send-pause window: read receipts only, broadcast nothing.
          if (opts.rebroadcast !== undefined && !opts.rebroadcast(intent)) continue;
          try {
            await this.o.rpc.sendRaw(intent.raw);
            this.trouble.delete(intent.id);
            this.o.append({ t: 'rebroadcast', id: intent.id, chain: this.o.chain, hash: intent.hash });
          } catch (err) {
            const reason = this.broadcastFailed(intent, err, 'rebroadcast');
            const drop = this.o.dropRejected;
            const t = this.trouble.get(intent.id);
            const ageMs = this.nowMs() - (typeof intent.at === 'number' ? intent.at : this.nowMs());
            if (reason !== undefined && drop !== undefined && t !== undefined && t.rejections >= drop.after && ageMs >= drop.minAgeMs) {
              // Not mined, not known to the node, nonce unused, and refused again and again: free the key.
              this.result(intent, 'dropped', { reason, error: t.lastError });
              done.push({ intent, outcome: { kind: 'dropped', id: intent.id, reason } });
              this.o.log?.(`dropped ${intent.call} ${intent.hash} on ${intent.chain} after ${t.rejections} refusals (${reason}); the key is free again`);
              if (reason === 'funds') {
                this.cooldownUntilMs = this.nowMs() + drop.fundsCooldownMs * 2 ** Math.min(3, this.fundsDrops);
                this.fundsDrops += 1;
              }
            }
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
