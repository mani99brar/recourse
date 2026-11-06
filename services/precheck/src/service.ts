// The pre-check service. Per claim the journal holds a chain of states: seen -> resolved (the six
// slots proved) -> built (document bytes, written before pinning) -> pinned (cid) -> intent (the
// signed transaction is journaled by the sender) -> recorded (PreCheckRecorded seen on the mirror
// with our packHash), or conflict (the chain holds a different packHash) or closed (the claim left
// Filed with no pre-check) or skipped (the claim names a platform or shop that is not a party).
// State is a fold over the journal, so a restart rebuilds it exactly.
//
// Only claims between parties of the party map are answered. Anyone can file a claim naming any
// shop address (an address the platform controls, say) against a registered platform, and the
// platform writes most of an order's records itself, so a finding for such a claim could pay out
// of the platform's deposit to whoever filed it. The safe answer to a claim naming an unknown shop
// or platform is no pre-check at all: the claim stays Filed, expires after claimTimeout and pays
// nothing; the filer only gets its court fee back. That is recorded as `claimSkipped` and alerted.

import {
  Alerter,
  HederaLogReader,
  JournalError,
  Sender,
  TransientError,
  backoffMs,
  claimsAbi,
  openJournal,
  replayJournal,
  type FetchLike,
  type Journal,
  type JournalRecord,
  type MirrorClient,
  type MirrorLog,
  type SenderOptions,
  type TxRpc,
  type TxSigner,
} from '@recourse/keeper';
import {
  ClaimStatus,
  isHex32,
  isSendPaused,
  packHash as hashDoc,
  partyWithRole,
  type Parties,
  type RecordRefs,
} from '@recourse/shared';
import { decodeEventLog, getAddress, hexToBytes, bytesToHex, type Address, type Hex } from 'viem';
import { systemClock, type Clock } from './clock.js';
import type { PrecheckConfig } from './config.js';
import type { DocStore } from './docs.js';
import { DOC_WAIT_S, proveClaim, type ProofClaim, type ProofPorts } from './proof.js';
import { runRule } from './ruleAdapter.js';
import { buildResultDoc } from './resultDoc.js';
import { slotFromJson, slotToJson, type SlotOutcome } from './slots.js';
import { TopicIndex } from './topicIndex.js';
import { RecordWriter, type ClaimsChain } from './writer.js';

export type ClaimState = 'seen' | 'resolved' | 'built' | 'pinned' | 'intent' | 'recorded' | 'conflict' | 'closed' | 'skipped';

const TERMINAL: readonly ClaimState[] = ['recorded', 'conflict', 'closed', 'skipped'];
const LATE_MS = 10 * 60_000;
/** While a claim's records cannot be proved yet, its status on chain is read at most this often. */
const CHAIN_CHECK_MS = 10 * 60_000;
const SOURCE_ALERT_MS = 2 * 60_000;

interface Built {
  bytes: Uint8Array;
  packHash: Hex;
  gap: number;
  answer: number;
  reasonKey: string;
}

interface ClaimRuntime {
  claimId: Hex;
  orderId: Hex;
  refs: RecordRefs;
  filedAt: bigint;
  /** From ClaimFiled; absent only in a journal written before they were recorded. */
  platform?: string;
  shop?: string;
  state: ClaimState;
  slots?: SlotOutcome[];
  built?: Built;
  cid?: string;
  failures: number;
  nextAttemptAt: number;
  retryingSince?: number;
  lastError?: string;
  inFlight: boolean;
  suspects: Map<string, Hex>;
  unread: Map<string, number>;
  /** Clock ms of the last read of the claim's status on chain while its records were not proved yet. */
  chainCheckedAt?: number;
}

export interface ServiceDeps {
  config: PrecheckConfig;
  parties: Parties;
  mirror: MirrorClient;
  docs: DocStore;
  chain: ClaimsChain;
  rpc: TxRpc;
  /** Absent in dry-run mode: nothing is pinned, signed or sent. */
  signer?: TxSigner;
  /** Address used to simulate the call when there is no signer. */
  from: Address;
  clock?: Clock;
  /** For alert posts. */
  fetch?: FetchLike;
  senderOptions?: Partial<SenderOptions>;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface ResultView {
  claimId: Hex;
  state: ClaimState;
  packHash?: Hex;
  cid?: string;
  gap?: string;
  answer?: string;
  reasonKey?: string;
  slots: { kind: string; outcome: string; reason?: string }[];
}

function str(rec: JournalRecord, key: string): string {
  const v = rec[key];
  if (typeof v !== 'string') throw new JournalError(`journal: ${rec.t} record has no string ${key}`);
  return v;
}

function hex32(rec: JournalRecord, key: string): Hex {
  const v = str(rec, key);
  if (!isHex32(v)) throw new JournalError(`journal: ${rec.t} record field ${key} is not a 32-byte hash`);
  return v;
}

function strings(rec: JournalRecord, key: string): string[] {
  const v = rec[key];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === 'string')) {
    throw new JournalError(`journal: ${rec.t} record field ${key} is not a list of strings`);
  }
  return v;
}

function sixOf<T>(items: readonly T[], what: string): [T, T, T, T, T, T] {
  const [a, b, c, d, e, f, ...rest] = items;
  if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || f === undefined || rest.length > 0) {
    throw new Error(`${what}: expected six entries`);
  }
  return [a, b, c, d, e, f];
}

function refsOf(topicNum: bigint, seq: readonly bigint[], hashes: readonly Hex[]): RecordRefs {
  return { topicNum, seq: sixOf(seq, 'refs.seq'), hashes: sixOf(hashes, 'refs.hashes') };
}

export class PrecheckService {
  private readonly claims = new Map<string, ClaimRuntime>();
  private readonly observed = new Map<string, Hex>();
  private readonly errors = new Map<string, { since: number; message: string }>();
  private readonly clock: Clock;
  private journal!: Journal;
  private alerter!: Alerter;
  private sender!: Sender;
  private writer!: RecordWriter;
  private index!: TopicIndex;
  private reader!: HederaLogReader;
  private lastError: string | undefined;
  private mirrorLagS: number | undefined;

  private constructor(private readonly d: ServiceDeps) {
    this.clock = d.clock ?? systemClock;
  }

  /** Opens the state directory, rebuilds claim state from the journal and settles open transactions. */
  static async create(deps: ServiceDeps): Promise<PrecheckService> {
    const s = new PrecheckService(deps);
    await s.start();
    return s;
  }

  private log(line: string): void {
    this.d.log?.(line);
  }

  private async start(): Promise<void> {
    const cfg = this.d.config;
    const replay = replayJournal(cfg.stateDir);
    if (replay.badLines.length > 0) {
      throw new JournalError(`journal: unreadable lines ${replay.badLines.join(',')}; not starting on a damaged journal`);
    }
    this.journal = openJournal(cfg.stateDir);
    // Appends from the alerter and the sender go through `record`, which also folds them into state.
    const append = (r: JournalRecord) => this.record(r);
    this.alerter = new Alerter({
      service: 'precheck',
      url: cfg.alertUrl,
      append,
      now: () => this.clock.now(),
      fetch: this.d.fetch,
      log: (l) => this.log(l),
    });
    this.sender = new Sender({
      chain: 'hedera',
      rpc: this.d.rpc,
      signer: this.d.signer,
      from: this.d.from,
      append,
      nonceTag: 'latest',
      log: (l) => this.log(l),
      ...this.d.senderOptions,
    });
    this.writer = new RecordWriter({
      sender: this.sender,
      chain: this.d.chain,
      claims: cfg.claimsAddress,
      docs: this.d.docs,
      alerter: this.alerter,
      windows: cfg.pauseWindows,
      clock: this.clock,
    });
    // State is the fold of the journal. Claims that reached recorded, conflict or closed stay there:
    // they are not in `open()`, so nothing about them is looked up again.
    for (const r of replay.records) this.apply(r);
    this.alerter.load(replay.records);
    this.sender.load(replay.records);
    this.index = TopicIndex.open({
      mirror: this.d.mirror,
      topicId: cfg.topicId,
      dir: cfg.stateDir,
      clock: this.clock,
      parties: this.d.parties,
      log: (l) => this.log(l),
    });
    this.reader = new HederaLogReader({
      mirror: this.d.mirror,
      contract: cfg.claimsAddress,
      dir: cfg.stateDir,
      source: 'claims-logs',
      startTimestamp: cfg.startTimestamp,
    });
    if (this.sender.openIntents().length > 0) await this.sender.resolveOpen();
  }

  close(): void {
    this.index.close();
    this.journal.close();
  }

  // ---- journal: every state change is a record, and state is the fold of the records ----

  private record(rec: JournalRecord): void {
    this.journal.append(rec);
    this.apply(rec);
  }

  private claim(rec: JournalRecord): ClaimRuntime {
    const c = this.claims.get(str(rec, 'claimId').toLowerCase());
    if (c === undefined) throw new JournalError(`journal: ${rec.t} record for a claim never seen`);
    return c;
  }

  private apply(rec: JournalRecord): void {
    switch (rec.t) {
      case 'claimSeen': {
        const claimId = hex32(rec, 'claimId');
        if (this.claims.has(claimId)) return;
        this.claims.set(claimId, {
          claimId,
          orderId: hex32(rec, 'orderId'),
          refs: refsOf(BigInt(str(rec, 'topicNum')), strings(rec, 'seq').map(BigInt), strings(rec, 'hashes').map((h) => {
            if (!isHex32(h)) throw new JournalError('journal: claimSeen has a bad hash');
            return h;
          })),
          filedAt: BigInt(str(rec, 'filedAt')),
          ...(typeof rec.platform === 'string' ? { platform: rec.platform } : {}),
          ...(typeof rec.shop === 'string' ? { shop: rec.shop } : {}),
          state: 'seen',
          failures: 0,
          nextAttemptAt: 0,
          inFlight: false,
          suspects: new Map(),
          unread: new Map(),
        });
        return;
      }
      case 'claimResolved': {
        const c = this.claim(rec);
        const slots = rec.slots;
        if (!Array.isArray(slots)) throw new JournalError('journal: claimResolved has no slots');
        c.slots = slots.map(slotFromJson);
        c.state = 'resolved';
        return;
      }
      case 'claimBuilt': {
        const c = this.claim(rec);
        const bytes = hexToBytes(str(rec, 'doc') as Hex);
        const ph = hex32(rec, 'packHash');
        if (hashDoc(bytes) !== ph) throw new JournalError('journal: claimBuilt packHash does not match its document');
        c.built = { bytes, packHash: ph, gap: Number(rec.gap), answer: Number(rec.answer), reasonKey: str(rec, 'reasonKey') };
        c.state = 'built';
        return;
      }
      case 'claimPinned': {
        const c = this.claim(rec);
        c.cid = str(rec, 'cid');
        c.state = 'pinned';
        return;
      }
      case 'intent': {
        this.writer?.observe(rec);
        if (rec.call === 'recordPreCheck' && typeof rec.claimId === 'string') {
          const c = this.claims.get(rec.claimId.toLowerCase());
          if (c !== undefined && !TERMINAL.includes(c.state)) c.state = 'intent';
        }
        return;
      }
      case 'result':
        this.writer?.observe(rec);
        return;
      case 'claimRecorded':
        this.claim(rec).state = 'recorded';
        return;
      case 'claimConflict':
        this.claim(rec).state = 'conflict';
        return;
      case 'claimClosed':
        this.claim(rec).state = 'closed';
        return;
      case 'claimSkipped':
        this.claim(rec).state = 'skipped';
        return;
      case 'preCheckSeen':
        if (!this.observed.has(hex32(rec, 'claimId'))) this.observed.set(hex32(rec, 'claimId'), hex32(rec, 'packHash'));
        return;
      default:
        return; // alerts and other kinds belong to their own readers
    }
  }

  // ---- reading the chain ----

  private handleLog(log: MirrorLog): void {
    if (log.address.toLowerCase() !== this.d.config.claimsAddress.toLowerCase()) return;
    const [sig, ...rest] = log.topics;
    if (sig === undefined) return;
    let ev;
    try {
      ev = decodeEventLog({ abi: claimsAbi, data: log.data, topics: [sig, ...rest] });
    } catch {
      return; // an event this service does not read
    }
    if (ev.eventName === 'ClaimFiled') {
      const a = ev.args;
      const claimId = a.claimId.toLowerCase() as Hex;
      if (this.claims.has(claimId)) return;
      this.record({
        t: 'claimSeen',
        claimId,
        orderId: a.orderId.toLowerCase(),
        shop: getAddress(a.shop),
        platform: getAddress(a.platform),
        topicNum: a.refs.topicNum.toString(),
        seq: a.refs.seq.map((s) => s.toString()),
        hashes: a.refs.hashes.map((h) => h.toLowerCase()),
        filedAt: a.filedAt.toString(),
        logTs: log.timestamp,
        tx: log.transactionHash,
      });
    } else if (ev.eventName === 'PreCheckRecorded') {
      const claimId = ev.args.claimId.toLowerCase() as Hex;
      if (this.observed.has(claimId)) return;
      this.record({ t: 'preCheckSeen', claimId, packHash: ev.args.packHash.toLowerCase(), logTs: log.timestamp });
    }
  }

  private async pollLogs(): Promise<void> {
    const { logs } = await this.reader.poll();
    for (const log of logs) this.handleLog(log);
    this.reader.commit(logs);
  }

  private open(): ClaimRuntime[] {
    return [...this.claims.values()]
      .filter((c) => !TERMINAL.includes(c.state))
      .sort((a, b) => (a.filedAt === b.filedAt ? (a.claimId < b.claimId ? -1 : 1) : a.filedAt < b.filedAt ? -1 : 1));
  }

  private async guard(source: string, kind: 'mirror_lag' | 'rpc_down', fn: () => Promise<void>): Promise<void> {
    const now = this.clock.now();
    try {
      await fn();
      this.errors.delete(source);
    } catch (err) {
      const message = `${source}: ${err instanceof Error ? err.message : String(err)}`;
      const prev = this.errors.get(source);
      const since = prev?.since ?? now;
      this.errors.set(source, { since, message });
      this.lastError = message;
      this.log(`error ${message}`);
      if (now - since >= SOURCE_ALERT_MS) {
        this.alerter.raise({ kind, hint: `${source} has been failing for over two minutes`, detail: { problem: message } });
      }
    }
  }

  /** Shared work for one tick: triggers, topic index, tip probe, open transactions, mirror lag, alerts. */
  async refresh(): Promise<void> {
    await this.guard('claim logs', 'mirror_lag', () => this.pollLogs());
    await this.guard('topic index', 'mirror_lag', async () => {
      await this.index.advance();
    });
    const cfg = this.d.config;
    if (this.open().some((c) => c.state === 'seen' && this.index.needsProbe(c.filedAt, cfg.quietS))) {
      await this.guard('topic tip', 'mirror_lag', async () => {
        await this.index.probeTip();
      });
    }
    if (this.sender.openIntents().length > 0) {
      await this.guard('open transactions', 'rpc_down', async () => {
        await this.sender.resolveOpen();
      });
    }
    await this.guard('mirror blocks', 'mirror_lag', async () => {
      const ts = await this.d.mirror.newestBlockTimestamp();
      this.mirrorLagS = Math.max(0, Math.floor(this.clock.now() / 1000) - Number(ts.split('.')[0]));
    });
    try {
      await this.alerter.flush();
    } catch {
      // flush keeps what it could not send
    }
  }

  // ---- per claim ----

  private ports(c: ClaimRuntime): ProofPorts {
    return {
      index: this.index,
      mirror: this.d.mirror,
      docs: this.d.docs,
      parties: this.d.parties,
      topicNum: this.d.config.topicNum,
      quietS: this.d.config.quietS,
      clock: this.clock,
      suspects: c.suspects,
      unread: c.unread,
      docWaitS: this.d.config.docWaitS ?? DOC_WAIT_S,
    };
  }

  /** The claim's platform and shop when both are parties with those roles; else undefined. */
  private claimParties(c: ClaimRuntime): { platform: string; shop: string } | undefined {
    if (c.platform === undefined || c.shop === undefined) return undefined;
    if (partyWithRole(this.d.parties, 'platform', c.platform) === undefined) return undefined;
    if (partyWithRole(this.d.parties, 'shop', c.shop) === undefined) return undefined;
    return { platform: c.platform, shop: c.shop };
  }

  /**
   * While the records cannot be proved yet, reads the claim on chain now and then; a claim that has
   * left Filed (expired, say) is closed, so it is not retried for ever. True when it was closed.
   */
  private async closedOnChain(c: ClaimRuntime): Promise<boolean> {
    const now = this.clock.now();
    if (c.chainCheckedAt !== undefined && now - c.chainCheckedAt < CHAIN_CHECK_MS) return false;
    if (c.chainCheckedAt === undefined && c.retryingSince === undefined) {
      c.chainCheckedAt = now; // first failed look: the claim was just seen Filed, read it in ten minutes
      return false;
    }
    c.chainCheckedAt = now;
    let onchain;
    try {
      onchain = await this.d.chain.getClaim(c.claimId);
    } catch {
      return false; // the rpc is down: the proof's own reason stays the claim's error
    }
    if (onchain.status === ClaimStatus.None || onchain.status === ClaimStatus.Filed) return false;
    this.record({ t: 'claimClosed', claimId: c.claimId, status: onchain.status });
    return true;
  }

  private progress(c: ClaimRuntime): void {
    c.failures = 0;
    c.retryingSince = undefined;
    c.nextAttemptAt = 0;
    c.lastError = undefined;
  }

  /** Compares what the mirror shows on chain with our document. True when the claim reached a terminal state. */
  private checkObserved(c: ClaimRuntime): boolean {
    if (c.built === undefined) return false;
    const seen = this.observed.get(c.claimId);
    if (seen === undefined) return false;
    if (seen === c.built.packHash) {
      this.record({ t: 'claimRecorded', claimId: c.claimId, packHash: seen });
    } else {
      this.conflict(c, seen);
    }
    return true;
  }

  private conflict(c: ClaimRuntime, onchain: Hex): void {
    this.record({ t: 'claimConflict', claimId: c.claimId, onchain, ours: c.built?.packHash });
    this.alerter.raise({
      kind: 'precheck_conflict',
      claimId: c.claimId,
      state: 'conflict',
      hint: 'the chain holds a different packHash from the one this service built; no further send for this claim',
      detail: { onchain, ours: c.built?.packHash ?? 'unbuilt' },
    });
  }

  private async advance(c: ClaimRuntime): Promise<void> {
    if (this.checkObserved(c)) return;
    if (c.state === 'seen') {
      const parties = this.claimParties(c);
      if (parties === undefined) {
        // No pre-check for a claim outside the party map: see the note at the top of this file.
        this.record({ t: 'claimSkipped', claimId: c.claimId, reason: 'unknown_party', platform: c.platform, shop: c.shop });
        this.alerter.raise({
          kind: 'claim_held',
          claimId: c.claimId,
          state: 'skipped',
          hint: 'the claim names a platform or shop that is not in the party map; no pre-check is recorded and it will expire',
          detail: { platform: c.platform ?? 'unknown', shop: c.shop ?? 'unknown' },
        });
        return;
      }
      const claim: ProofClaim = { claimId: c.claimId, orderId: c.orderId, filedAt: c.filedAt, refs: c.refs, ...parties };
      const proof = await proveClaim(claim, this.ports(c));
      if (!proof.final) {
        if (await this.closedOnChain(c)) return;
        for (const seq of proof.payerUnresolved) {
          this.alerter.raise({
            kind: 'mirror_lag',
            claimId: c.claimId,
            state: c.state,
            hint: 'no payer could be found for a topic message; the slot stays open until the mirror has it',
            detail: { seq: seq.toString() },
          });
        }
        throw new TransientError(proof.why.join('; '));
      }
      this.record({ t: 'claimResolved', claimId: c.claimId, slots: proof.slots.map(slotToJson) });
      this.progress(c);
    }
    if (c.state === 'resolved') {
      if (c.slots === undefined) throw new JournalError('journal: resolved claim without slots');
      const result = runRule(c.slots, c.orderId);
      const doc = buildResultDoc({ claimId: c.claimId, orderId: c.orderId, slots: c.slots, result });
      this.record({
        t: 'claimBuilt',
        claimId: c.claimId,
        doc: bytesToHex(doc.bytes),
        packHash: doc.packHash,
        gap: result.gap,
        answer: result.answer,
        reasonKey: result.reasonKey,
      });
      this.progress(c);
    }
    if (this.checkObserved(c)) return;
    const built = c.built;
    if (built === undefined) throw new JournalError('journal: built claim without a document');
    if (c.state === 'built') {
      if (this.d.dryRun === true) {
        await this.write(c, built);
        return;
      }
      const cid = await this.d.docs.pin(built.bytes);
      if (!/^[A-Za-z0-9]+$/.test(cid)) throw new Error('the pin client returned something that is not a CID');
      this.record({ t: 'claimPinned', claimId: c.claimId, cid });
      this.progress(c);
    }
    if (c.state === 'pinned' || c.state === 'intent') await this.write(c, built);
  }

  private async write(c: ClaimRuntime, built: Built): Promise<void> {
    const res = await this.writer.write({
      claimId: c.claimId,
      gap: built.gap,
      answer: built.answer,
      packHash: built.packHash,
      ...(c.cid === undefined ? {} : { doc: { cid: c.cid, bytes: built.bytes } }),
    });
    switch (res.kind) {
      case 'conflict':
        this.conflict(c, res.onchain);
        return;
      case 'closed':
        this.record({ t: 'claimClosed', claimId: c.claimId, status: res.status });
        return;
      case 'dry':
        this.log(
          JSON.stringify({
            event: 'dry_run',
            would: 'recordPreCheck',
            claimId: c.claimId,
            gap: String(built.gap),
            answer: String(built.answer),
            packHash: built.packHash,
          }),
        );
        return;
      case 'sent':
        this.progress(c);
        return;
      case 'waiting':
        return;
    }
  }

  private failure(c: ClaimRuntime, err: unknown, now: number): void {
    const message = err instanceof Error ? err.message : String(err);
    c.failures += 1;
    c.retryingSince ??= now;
    c.lastError = message;
    c.nextAttemptAt = now + backoffMs(c.failures);
    if (err instanceof JournalError) {
      this.alerter.raise({ kind: 'journal_error', claimId: c.claimId, state: c.state, hint: 'the journal could not be read or written', detail: { problem: message } });
    } else if (!(err instanceof TransientError)) {
      this.log(`unexpected error for ${c.claimId}: ${message}`);
    }
    if (now - c.retryingSince >= LATE_MS) {
      this.alerter.raise({
        kind: 'precheck_stalled',
        claimId: c.claimId,
        state: c.state,
        hint: 'still retrying after ten minutes; the cause is in detail',
        detail: { problem: message },
      });
    }
  }

  private async step(c: ClaimRuntime): Promise<void> {
    const now = this.clock.now();
    try {
      if (now - Number(c.filedAt) * 1000 >= LATE_MS) {
        this.alerter.raise({
          kind: 'precheck_late',
          claimId: c.claimId,
          state: c.state,
          hint: 'no PreCheckRecorded yet, ten minutes after ClaimFiled',
          detail: c.lastError === undefined ? undefined : { lastError: c.lastError },
        });
      }
      if (now < c.nextAttemptAt) return;
      await this.advance(c);
    } catch (err) {
      this.failure(c, err, now);
    }
  }

  private startSteps(): Promise<void>[] {
    const started: Promise<void>[] = [];
    for (const c of this.open()) {
      if (c.inFlight) continue;
      c.inFlight = true;
      started.push(
        this.step(c).finally(() => {
          c.inFlight = false;
        }),
      );
    }
    return started;
  }

  /** One full tick; resolves when every claim step it started has finished. */
  async tick(): Promise<void> {
    await this.refresh();
    await Promise.allSettled(this.startSteps());
  }

  /** One tick for a running service: claim steps are left to finish on their own, so a slow claim never holds up the next tick. */
  async pump(): Promise<void> {
    await this.refresh();
    this.startSteps();
  }

  // ---- views ----

  claimStates(): Record<string, ClaimState> {
    return Object.fromEntries([...this.claims.values()].map((c) => [c.claimId, c.state]));
  }

  result(claimId: string): ResultView | undefined {
    const c = this.claims.get(claimId.toLowerCase());
    if (c === undefined) return undefined;
    const v: ResultView = { claimId: c.claimId, state: c.state, slots: [] };
    if (c.slots !== undefined) {
      v.slots = c.slots.map((s) => ({
        kind: String(s.kind),
        outcome: s.outcome,
        ...(s.outcome === 'rejected' ? { reason: s.reason } : {}),
      }));
    }
    if (c.built !== undefined) {
      v.packHash = c.built.packHash;
      v.gap = String(c.built.gap);
      v.answer = String(c.built.answer);
      v.reasonKey = c.built.reasonKey;
    }
    if (c.cid !== undefined) v.cid = c.cid;
    return v;
  }

  health(): Record<string, unknown> {
    const counts: Record<string, number> = {};
    for (const c of this.claims.values()) counts[c.state] = (counts[c.state] ?? 0) + 1;
    const probe = this.index.probe;
    const now = this.clock.now();
    return {
      ok: this.errors.size === 0,
      service: 'precheck',
      dryRun: this.d.dryRun === true,
      cursors: {
        claimLogs: { timestamp: this.reader.position },
        topic: {
          topicId: this.d.config.topicId,
          seq: this.index.lastSeq.toString(),
          consensusAt: this.index.lastConsensus ?? null,
          probe: probe === undefined ? null : { atMs: probe.atMs, newestSeq: probe.newestSeq.toString(), newestConsensus: probe.newestConsensus ?? null },
        },
      },
      lag: { mirrorS: this.mirrorLagS ?? null },
      lastError: this.lastError ?? null,
      errors: [...this.errors.values()].map((e) => e.message),
      queue: this.open().length,
      claims: counts,
      pause: {
        paused: isSendPaused(this.d.config.pauseWindows, 'hedera', Math.floor(now / 1000)),
        windows: this.d.config.pauseWindows.length,
      },
    };
  }
}
