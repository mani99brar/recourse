// The keeper: one machine per claim, driven by chain events and the lifecycle table. Every tick
// it reads the control file, refreshes live contract parameters, settles open transactions,
// ingests new events from both chains, then steps each open claim. Before any call it reads the
// chain again; the contract guards decide, and the journal is only a cache. Timed actions run
// from milestones in chain time, never from process start.

import {
  BridgeMode,
  CaseState,
  DecodeStatus,
  ExecutionState,
  canExpireClaim,
  encodeClaimToCourt,
  externalIdUint,
  isSendPaused,
  tryDecodeClaimToCourt,
  ClaimStatus,
  type SendPauseWindow,
  type VaultToken,
} from '@recourse/shared';
import { formatUnits, type Hex } from 'viem';
import type { Alert, AlertKind, Alerter } from './alerts.js';
import { ClaimBook, currentAttempt, isTerminal, milestoneOf, phaseOf } from './claims.js';
import { controlWindows, emptyControl, expiryForced, operatorHolds, readControl, releasedSince, type Control } from './control.js';
import type { EvidencePort } from './evidence.js';
import { JOURNAL_FILE, streamJournal, type Journal, type JournalRecord } from './journal.js';
import { DEFAULT_TIMING, rowOf, type Row, type Timing } from './table.js';
import type {
  BridgeMsg,
  CallResult,
  CaseParams,
  Chain,
  ChainEvent,
  Chains,
  ClaimsParams,
  CourtAttempt,
  DisputeInfo,
  KeeperCall,
  KeeperClaim,
  Levels,
  Phase,
  ResolvedCall,
} from './types.js';

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/** Case states `markStale` moves to Stale once the case has expired. */
const STALEABLE: readonly CaseState[] = [CaseState.Received, CaseState.Opened, CaseState.RefilePending];
/** Phases in which the Arbitrum case may be in one of those states. */
const CASE_PHASES: readonly Phase[] = ['Sent', 'Delivered', 'Opened', 'Watching', 'RefilePending'];

export interface KeeperOptions {
  chains: Chains;
  journal: Journal;
  alerter: Alerter;
  /** Folder of the journal and the control file. */
  stateDir: string;
  evidence: EvidencePort;
  /** Send-pause windows from the environment; the control file may add more. */
  windows?: readonly SendPauseWindow[];
  timing?: Partial<Timing>;
  /** Unix seconds. */
  now?: () => number;
  /** Funding floors for the gas and fee alerts (DEFAULT_FLOORS when absent). */
  floors?: FundingFloors;
  log?: (line: string) => void;
  /** Explorer and court link builders for alerts. */
  links?: Partial<Links>;
  /** The vault's token, from the Hedera deployment record: alerts name vault amounts in it. */
  vaultToken: VaultToken;
  /** Compact the journal once it reaches this many bytes (default 8 MiB). */
  compactAtBytes?: number;
}

export const DEFAULT_COMPACT_AT_BYTES = 8 * 1024 * 1024;

/** Balances under which the keeper raises gas_low or link_low. */
export interface FundingFloors {
  /** ops-hedera, weibar (10^18 per HBAR). */
  opsHederaWeibar: bigint;
  /** ops-arb, wei. */
  opsArbWei: bigint;
  /** HBAR (weibar) the claims contract should hold for CCIP fees when it pays natively. A live quote raises it to 3 sends. */
  claimsFeeWeibar: bigint;
  /** LINK (wei) the claims contract should hold when it pays CCIP fees in LINK. A live quote raises it to 3 sends. */
  claimsFeeLink: bigint;
}

/**
 * ops-hedera's floor is the one in docs/keys.md (10 HBAR). docs/keys.md gives ops-arb none; 0.01
 * ETH covers several openCase and relay sends at testnet prices. The claims contract floors are 3
 * sends at the measured quotes (2.2 HBAR or 0.013 LINK each).
 */
export const DEFAULT_FLOORS: FundingFloors = {
  opsHederaWeibar: 10n * 10n ** 18n,
  opsArbWei: 10n ** 16n,
  claimsFeeWeibar: 66n * 10n ** 17n,
  claimsFeeLink: 4n * 10n ** 16n,
};

/** A balance in whole units for an alert (18 decimals: weibar to HBAR, wei to ETH or LINK). */
const units = (v: bigint): string => formatUnits(v, 18);

export interface Links {
  ccipMessage: (messageId: Hex) => string;
  courtCase: (disputeId: string) => string;
}

const DEFAULT_LINKS: Links = {
  ccipMessage: (id) => `https://ccip.chain.link/msg/${id}`,
  courtCase: (id) => `https://v2-testnet.kleros.builders/#/cases/${id}/overview`,
};

export interface KeeperHealth {
  lastTickAt?: number;
  /** The latest error, while it is current: a tick that runs without one clears it. */
  lastError?: string;
  /** When the latest error happened (keeper clock, unix s); kept after lastError clears. */
  lastErrorAt?: number;
  /** The last few errors, oldest first. */
  recentErrors: { at: number; what: string }[];
  paused: boolean;
  windowsActive: string[];
  mode?: BridgeMode;
  claimsParams?: ClaimsParams;
  caseParams?: CaseParams;
  paramsError?: string;
  cursors: { hedera?: string; arbitrum?: string };
  hederaLagS?: number;
  claimsByPhase: Record<string, number>;
  levels?: {
    feePool: string;
    costNow: string;
    openCases: number;
    opsHederaWeibar: string;
    opsArbWei: string;
    claimsLink: string;
    caseLink: string;
    claimsFeeToken?: string;
    claimsNativeWeibar?: string;
  };
}

export class Keeper {
  readonly book: ClaimBook;
  readonly health: KeeperHealth = { paused: false, windowsActive: [], cursors: {}, claimsByPhase: {}, recentErrors: [] };
  /** Errors noted in the tick that is running. */
  private tickErrors = 0;
  private readonly timing: Timing;
  private readonly links: Links;
  private control: Control = emptyControl();
  /** One court round in seconds, once read. */
  private courtRound?: number;
  private windows: SendPauseWindow[] = [];
  private claimsParams?: ClaimsParams;
  private caseParams?: CaseParams;
  private mode?: BridgeMode;
  private lastLevelsAt = 0;
  private handledGlobal = 0;

  constructor(private readonly o: KeeperOptions) {
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.links = { ...DEFAULT_LINKS, ...o.links };
    this.book = new ClaimBook(o.journal, {
      caseAddress: o.chains.caseAddress,
      arbChainId: o.chains.arbChainId,
      opsArb: o.chains.opsArb,
    });
  }

  private now(): number {
    return (this.o.now ?? (() => Math.floor(Date.now() / 1000)))();
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  /**
   * Loads the journal in one streamed pass: claims from their events and last snapshots, the
   * alert clock and outbox, and the intents that have no result yet (the senders settle those
   * before anything new is sent). Only open intents are held while reading, never every record.
   */
  start(): void {
    const intents = new Map<string, JournalRecord>();
    const replay = streamJournal(this.o.stateDir, JOURNAL_FILE, (r) => {
      if (r.t === 'intent') intents.set(String(r.id), r);
      else if (r.t === 'result') intents.delete(String(r.id));
      this.book.loadRecord(r);
      this.o.alerter.loadRecord(r);
    });
    if (replay.badLines.length > 0) {
      this.o.alerter.raise({
        kind: 'journal_error',
        hint: `journal lines ${replay.badLines.join(', ')} do not parse and were skipped; follow "Journal lines that do not parse" in services/keeper/RUNBOOK.md`,
      });
    }
    this.o.chains.load([...intents.values()]);
    this.handledGlobal = this.book.globalEvents.length;
  }

  /**
   * Rewrites the journal as the state it describes (see ClaimBook.compact): claim snapshots,
   * evidence of open claims, recent event keys, open intents verbatim, the alert clock and the
   * unsent alerts. Atomic (Journal.rewrite); a no-op when the journal or the chain port cannot do
   * it safely. Returns true when it rewrote.
   */
  compact(): boolean {
    const j = this.o.journal;
    const intents = this.o.chains.openIntentRecords?.();
    if (j.rewrite === undefined || intents === undefined) return false;
    const before = j.size?.() ?? 0;
    this.book.dropHandledGlobal(this.handledGlobal);
    this.handledGlobal = 0;
    const records: JournalRecord[] = [
      { t: 'compacted', fromBytes: before },
      ...this.book.compact(Date.now()),
      ...intents,
      ...this.o.alerter.compact(),
    ];
    j.rewrite(records);
    this.log(`journal compacted: ${before} bytes -> ${j.size?.() ?? '?'} bytes, ${records.length} records`);
    return true;
  }

  // ------------------------------------------------------------------ tick

  async tick(): Promise<void> {
    const now = this.now();
    this.health.lastTickAt = now;
    this.tickErrors = 0;
    try {
      this.control = readControl(this.o.stateDir);
    } catch (err) {
      this.noteError(`control file unreadable: ${msg(err)}`);
    }
    const extra = controlWindows(this.control);
    this.windows = [...(this.o.windows ?? []), ...extra.windows];
    this.health.paused = this.control.paused;
    this.health.windowsActive = this.windows.filter((w) => w.from <= now && now < w.to).map((w) => `${w.chain}@${w.from}/${w.to}`);

    await this.refreshParams();
    await this.guard('resolve open transactions', async () => {
      // Receipts are always read; a stored transaction is broadcast again only when a send could go now.
      const settled = await this.o.chains.resolveOpen({ rebroadcast: (chain, call) => this.canSend(chain, call, now) });
      for (const s of settled ?? []) this.settled(s, now);
      this.stuckIntents();
    });
    const hederaOk = await this.guard('hedera events', () => this.ingestHedera());
    const arbitrumOk = await this.guard('arbitrum events', () => this.ingestArbitrum());
    await this.guard('bridge-wide events', () => this.handleGlobalEvents(now));
    if (now - this.lastLevelsAt >= this.timing.levelsEveryS) {
      await this.guard('funding levels', () => this.checkLevels());
      this.lastLevelsAt = now;
    }
    for (const c of this.book.open()) {
      try {
        await this.step(c, now);
      } catch (err) {
        c.lastError = msg(err);
        c.lastErrorAt = now;
        this.noteError(`${c.claimId}: ${msg(err)}`);
        this.log(`claim ${c.claimId}: ${msg(err)}`);
      }
    }
    for (const c of this.book.claims.values()) if (isTerminal(c)) await this.guard('terminal', () => this.terminal(c, now));
    const counts: Record<string, number> = {};
    for (const c of this.book.claims.values()) counts[phaseOf(c)] = (counts[phaseOf(c)] ?? 0) + 1;
    this.health.claimsByPhase = counts;
    await this.o.alerter.flush();
    // Only after both sources committed: every event ingested so far sits behind a saved cursor.
    if (hederaOk && arbitrumOk) this.maybeCompact();
    // A tick without an error means the last one is over (lastErrorAt and recentErrors keep it).
    if (this.tickErrors === 0) this.health.lastError = undefined;
  }

  private noteError(what: string): void {
    const at = this.now();
    this.tickErrors += 1;
    this.health.lastError = what;
    this.health.lastErrorAt = at;
    this.health.recentErrors.push({ at, what });
    if (this.health.recentErrors.length > 10) this.health.recentErrors.splice(0, this.health.recentErrors.length - 10);
  }

  /**
   * Whether the keeper is doing its job: it ticked within `staleAfterS` and can read the contract
   * params (without them every timed action waits). GET /health answers 503 when not.
   */
  status(staleAfterS: number): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const last = this.health.lastTickAt;
    if (last === undefined) problems.push('no tick yet');
    else if (this.now() - last > staleAfterS) problems.push(`last tick ${this.now() - last} s ago`);
    if (this.health.paramsError !== undefined) problems.push(`params unreadable: ${this.health.paramsError}`);
    return { ok: problems.length === 0, problems };
  }

  private maybeCompact(): void {
    const size = this.o.journal.size?.();
    if (size === undefined || size < (this.o.compactAtBytes ?? DEFAULT_COMPACT_AT_BYTES)) return;
    try {
      this.compact();
    } catch (err) {
      this.noteError(`journal compaction: ${msg(err)}`);
      this.alert({ kind: 'journal_error', hint: `journal compaction failed (${msg(err)}); the old journal is untouched and still in use` });
    }
  }

  private async guard(what: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      this.noteError(`${what}: ${msg(err)}`);
      this.log(`${what}: ${msg(err)}`);
      this.alert({ kind: 'rpc_down', hint: `${what} failed: ${msg(err)}` });
      return false;
    }
  }

  private async refreshParams(): Promise<void> {
    try {
      this.claimsParams = await this.o.chains.claimsParams();
      this.caseParams = await this.o.chains.caseParams();
      this.mode = await this.o.chains.bridgeMode();
      this.health.paramsError = undefined;
    } catch (err) {
      // Timed actions wait; pre-lock and locked values differ, so there is no static fallback.
      this.claimsParams = undefined;
      this.caseParams = undefined;
      this.health.paramsError = msg(err);
      this.alert({ kind: 'params_unreadable', hint: `params() read failed: ${msg(err)}; timed actions are on hold` });
    }
    this.health.claimsParams = this.claimsParams;
    this.health.caseParams = this.caseParams;
    this.health.mode = this.mode;
  }

  private async ingestHedera(): Promise<void> {
    const events = await this.o.chains.pollHedera();
    for (const e of events) this.ingest(e);
    this.o.chains.commitHedera(events);
  }

  private async ingestArbitrum(): Promise<void> {
    const events = await this.o.chains.pollArbitrum({
      disputeIds: () => this.book.disputeIds(),
      externalIds: () => this.book.externalIds(),
      onCaseEvents: (evs) => {
        for (const e of evs) this.ingest(e);
      },
    });
    for (const e of events) this.ingest(e);
    this.o.chains.commitArbitrum(events);
  }

  /**
   * A call that came back pending has now been settled. Evidence is the one call no contract
   * guard stops from going twice, so a mined submitEvidence counts at once instead of waiting for
   * its Evidence log (read 20 blocks behind) while the 30-second retry runs.
   */
  private settled(s: ResolvedCall, now: number): void {
    if (s.claimId === undefined) return;
    const c = this.book.claims.get(s.claimId.toLowerCase());
    if (!c) return;
    if (s.call === 'submitEvidence' && s.outcome === 'success') {
      const a = currentAttempt(c);
      if (a && a.evidenceAt === undefined) {
        a.evidenceAt = now;
        a.evidenceTx = s.hash;
        this.book.save(c);
      }
    } else if (s.outcome === 'dropped') {
      this.log(`claim ${c.claimId}: ${s.call} ${s.hash} was dropped; the claim's next step reads the chain again`);
    }
  }

  /** Alerts on transactions open longer than `intentStuckS`: every later call on that key waits on them. */
  private stuckIntents(): void {
    for (const s of this.o.chains.intentStatus?.() ?? []) {
      if (s.ageS < this.timing.intentStuckS) continue;
      const kind: AlertKind = s.reason === 'funds' ? 'gas_low' : 'call_failed';
      const why = s.lastError ? `; last broadcast error: ${s.lastError}` : '';
      const hint =
        `${s.call} ${s.hash} (nonce ${s.nonce}) on ${s.chain} has been open for ${s.ageS} s and every later ${s.chain} call waits on it` +
        `${why}. ${s.reason === 'funds' ? `Fund the ops-${s.chain} key. ` : ''}The keeper drops it after repeated refusals and sends again; a transaction you send by hand with that nonce also frees it`;
      const subject = `intent-${s.chain}`;
      if (s.claimId) {
        const c = this.book.claims.get(s.claimId.toLowerCase());
        if (c) {
          this.alertClaim(c, kind, hint, { detail: { chain: s.chain, call: s.call, nonce: String(s.nonce), ageS: String(s.ageS) } });
          continue;
        }
      }
      this.alert({ kind, subject, hint, detail: { chain: s.chain, call: s.call, nonce: String(s.nonce), ageS: String(s.ageS) } });
    }
  }

  private ingest(e: ChainEvent): void {
    const { fresh, claimId } = this.book.ingest(e);
    if (fresh) this.log(`event ${e.chain} ${e.name}${claimId ? ` ${claimId}` : ''}`);
  }

  // ------------------------------------------------------------------ helpers

  private alert(a: Alert): void {
    this.o.alerter.raise(a);
  }

  private alertClaim(c: KeeperClaim, kind: AlertKind, hint: string, extra: Partial<Alert> = {}): void {
    this.alert({ kind, claimId: c.claimId, state: phaseOf(c), hint, ...extra });
  }

  private once(c: KeeperClaim, key: string): boolean {
    if (c.done.includes(key)) return false;
    c.done.push(key);
    this.book.save(c);
    return true;
  }

  private held(c: KeeperClaim): boolean {
    return operatorHolds(this.control, c.claimId) || c.autoHold !== undefined;
  }

  private hold(c: KeeperClaim, reason: string): void {
    c.autoHold = { reason, atMs: Date.now() };
    this.book.save(c);
  }

  /** False while paused, or while a pause window covers the chain the call lands on. */
  private canSend(chain: Chain, fn: string, now: number): boolean {
    if (this.control.paused) return false;
    if (isSendPaused(this.windows, chain, now)) return false;
    if (fn === 'relayRuling') {
      // The ruling lands on Hedera 15-25 min later: keep it out of the run-up to a Hedera window.
      const lead = this.timing.relayLeadS;
      if (this.windows.some((w) => w.chain === 'hedera' && w.from - lead <= now && now < w.to)) return false;
    }
    return true;
  }

  /**
   * Makes a call at most once per retry interval. Reverts count as failed tries; when the row's
   * limit is used up the claim is held and the row's alert goes out. A revert named in `benign`
   * is a timing race (the chain moved first, or its clock trails ours): it is logged, not counted.
   */
  private async tryCall(
    c: KeeperClaim,
    row: Row,
    call: KeeperCall,
    now: number,
    opts: { retryEveryS?: number; maxTries?: number; exhausted?: AlertKind; key?: string; benign?: readonly string[] } = {},
  ): Promise<CallResult | undefined> {
    const key = opts.key ?? call.fn;
    const t = c.tries[key];
    const every = opts.retryEveryS ?? row.retryEveryS ?? 120;
    if (t && now - t.lastAt < every) return undefined;
    if (this.o.chains.hasOpen(call.chain, call.fn, c.claimId)) return undefined;
    if (!this.canSend(call.chain, call.fn, now)) return undefined;
    const r = await this.o.chains.send({ ...call, claimId: c.claimId });
    if (r.kind === 'busy') return r;
    const benign = r.kind === 'reverted' && r.error !== undefined && (opts.benign ?? []).includes(r.error);
    c.tries[key] = { count: (t?.count ?? 0) + (r.kind === 'reverted' && !benign ? 1 : 0), lastAt: now };
    if (benign) {
      this.log(`claim ${c.claimId}: ${call.fn} reverted with ${r.error} (a timing race, not counted)`);
    } else if (r.kind === 'reverted') {
      c.lastError = `${call.fn} reverted${r.error ? ` with ${r.error}` : ''}${r.message ? `: ${r.message}` : ''}`;
      c.lastErrorAt = now;
      this.log(`claim ${c.claimId}: ${c.lastError}`);
      const max = opts.maxTries ?? row.maxTries;
      if (max !== undefined && c.tries[key]!.count >= max) {
        c.autoHold = { reason: `${call.fn} failed ${max} times (${r.error ?? 'reverted'})`, atMs: Date.now() };
        this.alertClaim(c, opts.exhausted ?? row.exhaustedAlert ?? row.stalls[0]?.kind ?? 'call_failed', `${call.fn} failed ${max} times; claim held. Check ${r.error ?? 'the revert'}, then keeper-ctl release ${c.claimId}`);
      }
    } else {
      this.log(`claim ${c.claimId}: ${call.fn} ${r.kind}${'hash' in r ? ` ${r.hash}` : ''}`);
    }
    this.book.save(c);
    return r;
  }

  private stalls(c: KeeperClaim, row: Row, now: number): void {
    const m = milestoneOf(c);
    if (m === undefined) return;
    for (const s of row.stalls) {
      let base = m;
      if (s.fromWindowEnd) {
        if (this.claimsParams === undefined || c.preCheckedAt === undefined) continue;
        base = c.preCheckedAt + this.claimsParams.contestWindow;
      }
      if (now < base + s.afterS) continue;
      const a = currentAttempt(c);
      if (s.kind === 'juror_absent' && a?.drawSeen) continue;
      if (s.kind === 'evidence_missed') continue; // raised by the Opened handler when it stops trying
      this.alertClaim(c, s.kind, `${phaseOf(c)} for ${now - m} s (expected ${row.expectedS ?? '-'} s)`);
    }
  }

  // ------------------------------------------------------------------ one claim

  async step(c: KeeperClaim, now: number): Promise<void> {
    if (c.autoHold && releasedSince(this.control, c.claimId, c.autoHold.atMs)) {
      this.log(`claim ${c.claimId}: released from hold (${c.autoHold.reason})`);
      c.autoHold = undefined;
      c.tries = {};
      this.book.save(c);
    }
    const phase = phaseOf(c);
    const a = currentAttempt(c);
    // Past a missed evidence period the claim waits on the court like a Watching one.
    const row = phase === 'Opened' && a && c.done.includes(`evidence-missed-${a.attempt}`) ? rowOf('Watching') : rowOf(phase);
    this.stalls(c, row, now);
    if (row.expirable && (await this.expiry(c, now))) return;
    if (CASE_PHASES.includes(phase) && (await this.markStale(c, now))) return;
    switch (phase) {
      case 'PreChecked':
        return this.preChecked(c, row, now);
      case 'Contested':
        return this.contested(c, row, now);
      case 'Sent':
        return this.sent(c, row, now);
      case 'Delivered':
        return this.delivered(c, row, now);
      case 'Opened':
        return this.opened(c, row, now);
      case 'Watching':
        return this.watching(c, row, now);
      case 'RefilePending':
        return this.refilePending(c, row, now);
      case 'RuledArb':
        return this.ruledArb(c, row, now);
      case 'Relayed':
        return this.relayed(c, row, now);
      case 'RuledHedera':
        return this.ruledHedera(c, row, now);
      default:
        return; // Filed and Stale only wait (precheck runs Filed; expiry covers Stale)
    }
  }

  /**
   * Expires a claim on Hedera once `expireClaim` would succeed: a Filed claim after filedAt +
   * claimTimeout, a Contested or AtCourt one after preCheckedAt + claimTimeout (strictly after, in
   * both cases); a PreChecked claim never. A court ruling that has not reached Hedera yet always
   * goes first, in every bridge mode: the keeper never expires such a claim itself unless the
   * operator ran keeper-ctl expire. Returns true when the row's own call must not run.
   */
  private async expiry(c: KeeperClaim, now: number): Promise<boolean> {
    if (this.claimsParams === undefined) return false;
    const timeout = this.claimsParams.claimTimeout;
    // No claim expires before filedAt + claimTimeout, so skip the read until then.
    if (c.filedAt !== undefined && now <= c.filedAt + timeout) return false;
    const claim = await this.o.chains.getClaim(c.claimId);
    if (!canExpireClaim(claim, BigInt(timeout), BigInt(now))) return false;
    if (operatorHolds(this.control, c.claimId)) return true;
    const forced = expiryForced(this.control, c.claimId);
    if (claim.status === ClaimStatus.AtCourt && !forced) {
      const pending = await this.pendingRuling(c);
      if (pending !== undefined) {
        const held = c.autoHold ? ` The claim is held (${c.autoHold.reason}); keeper-ctl release ${c.claimId} tries the ruling again.` : '';
        if (pending.unread) this.noteUnread(c, pending.why, now);
        this.alertClaim(
          c,
          'expiry_race',
          `claim timeout passed but ${pending.why}; expiry waits ${pending.unread ? 'until it can be read' : 'for the ruling'}.${held} To expire anyway, which makes Hedera ignore the ruling: keeper-ctl expire ${c.claimId}`,
          pending.messageId ? { links: [this.links.ccipMessage(pending.messageId)] } : {},
        );
        // The row's own call (relay, record, re-relay or executeRuling) is what delivers the ruling.
        return false;
      }
    }
    // Expiry is the escrow's way out, so a hold from some other call's failures does not stop it;
    // an operator hold, or a failed expiry, does.
    if (c.autoHold?.reason.startsWith('expireClaim')) return true;
    // NotExpired here means the chain's latest block trails our clock by a second or two.
    const r = await this.tryCall(c, rowOf(phaseOf(c)), { chain: 'hedera', contract: 'claims', fn: 'expireClaim', args: [c.claimId] }, now, {
      retryEveryS: 120,
      benign: ['NotExpired'],
    });
    if (r?.kind === 'reverted' && r.error !== 'NotExpired') {
      this.hold(c, `expireClaim reverted (${r.error ?? 'reverted'})`);
      this.alertClaim(c, 'expire_failed', `expireClaim reverted with ${r.error ?? 'no reason'}; claim held, escrow untouched. Read the claim status before keeper-ctl release`);
    }
    return true;
  }

  /**
   * Why a court ruling for this claim exists but has not reached Hedera, or undefined. Reads the
   * case on Arbitrum rather than trusting the journal, since the event reader can trail the chain
   * by many blocks after a downtime: a Ruled case still has its ruling to relay (or record, in
   * the one-leg modes); a Relayed case has a message in flight, or one that failed on the Hedera
   * OffRamp and can still be executed by hand; an Opened case whose Kleros dispute is in its
   * execution period has a final ruling that executeRuling delivers. A dispute that cannot be
   * read counts as pending (`unread`): a failed read never lets expiry throw a ruling away.
   */
  private async pendingRuling(c: KeeperClaim): Promise<{ why: string; messageId?: Hex; unread?: boolean } | undefined> {
    if (c.rulingReceivedAt !== undefined) return undefined;
    let changed = false;
    const inbound = async (messageId: Hex): Promise<ExecutionState> => {
      const st = await this.o.chains.execState('hedera', messageId);
      const m = c.inbound.find((x) => x.messageId === messageId);
      if (m && m.state !== st) {
        m.state = st;
        changed = true;
      }
      return st;
    };
    try {
      if (this.o.chains.hasOpen('arbitrum', 'relayRuling', c.claimId)) return { why: 'a relayRuling transaction is still open' };
      if (this.o.chains.hasOpen('hedera', 'recordRuling', c.claimId)) return { why: 'a recordRuling transaction is still open' };
      const cv = await this.o.chains.caseOf(c.claimId);
      if (cv.state === CaseState.Ruled) {
        const how = this.mode === BridgeMode.Both ? 'relayed' : 'recorded on Hedera';
        return { why: `the case on Arbitrum is Ruled (ruling ${cv.ruling}) and the ruling has not been ${how}` };
      }
      if (cv.state === CaseState.Relayed || c.inbound.length > 0) {
        // Every copy we know of, plus the case's latest (the reader may not have its event yet).
        const ids = c.inbound.map((m) => m.messageId);
        const last = cv.lastMessageId.toLowerCase() as Hex;
        if (cv.state === CaseState.Relayed && last !== ZERO32 && !ids.includes(last)) ids.push(last);
        const states: [Hex, ExecutionState][] = [];
        for (const id of ids) states.push([id, await inbound(id)]);
        if (states.some(([, st]) => st === ExecutionState.Success)) return undefined; // Hedera recorded or ignored it
        const flying = states.find(([, st]) => st === ExecutionState.Untouched || st === ExecutionState.InProgress);
        if (flying) return { why: `ruling message ${flying[0]} is still in flight`, messageId: flying[0] };
        const failed = states.find(([, st]) => st === ExecutionState.Failure);
        if (failed) return { why: `ruling message ${failed[0]} failed on the Hedera OffRamp and can still be executed by hand`, messageId: failed[0] };
        return undefined;
      }
      if (cv.state === CaseState.Opened && cv.attempts > 0) {
        const disputeId = cv.disputeIds[cv.attempts - 1]!;
        const k = await this.finalRuling(disputeId);
        if (k.state === 'final') return { why: `Kleros dispute ${disputeId} is in its execution period and executeRuling has not run` };
        if (k.state === 'unread') return { why: `Kleros dispute ${disputeId} could not be read (${k.error}), so a final ruling there cannot be ruled out`, unread: true };
      }
      return undefined;
    } finally {
      if (changed) this.book.save(c);
    }
  }

  /**
   * Whether a Kleros dispute holds a final ruling that has not been executed: 'final' when it is
   * ruled or in its execution period (4), 'unread' when the read failed, so that cannot be ruled
   * out, 'none' otherwise. Always 'none' on an arbitrator without dispute views (the local mock,
   * named by the deployment), whose rulings reach the case at once.
   */
  private async finalRuling(disputeId: bigint): Promise<{ state: 'final' | 'none' } | { state: 'unread'; error: string }> {
    if (!this.o.chains.disputeViews) return { state: 'none' };
    try {
      const d = await this.o.chains.dispute(disputeId);
      return { state: d.ruled || d.period === 4 ? 'final' : 'none' };
    } catch (err) {
      return { state: 'unread', error: msg(err) };
    }
  }

  /** A read that a destructive call waits on failed: the claim and /health show it until a clean tick. */
  private noteUnread(c: KeeperClaim, why: string, now: number): void {
    c.lastError = why;
    c.lastErrorAt = now;
    this.noteError(`${c.claimId}: ${why}`);
    this.log(`claim ${c.claimId}: ${why}; waiting`);
  }

  /**
   * The case's expiresAt on Arbitrum: the payload's filedAt plus the case contract's own claim
   * timeout (or the value the contract reported in a NotExpired revert). From that second on the
   * case cannot open or refile and `markStale` succeeds.
   */
  private caseExpiresAt(c: KeeperClaim): number | undefined {
    if (c.caseExpiresAt !== undefined) return c.caseExpiresAt;
    if (this.caseParams === undefined) return undefined;
    let filedAt = c.filedAt;
    if (c.received) {
      const d = tryDecodeClaimToCourt(c.received.payload);
      if (d.status === DecodeStatus.Ok) filedAt = Number(d.value.filedAt);
    }
    return filedAt === undefined ? undefined : filedAt + this.caseParams.claimTimeout;
  }

  /** Seconds one court round takes: read from the court once, or the fallback while it cannot be read. */
  private async courtRoundS(): Promise<number> {
    if (this.courtRound !== undefined) return this.courtRound;
    const read = this.o.chains.courtRoundS ? await this.o.chains.courtRoundS().catch(() => undefined) : undefined;
    if (read !== undefined && Number.isFinite(read) && read > 0) {
      this.courtRound = read;
      return read;
    }
    return this.timing.courtRoundFallbackS;
  }

  /**
   * True when a dispute opened now could not reach a ruling before the case expires: the round
   * would be killed by markStale at expiresAt and the arbitration fee spent for nothing. The case
   * is left to go stale at expiresAt, and the claim expires on Hedera with the fee refunded.
   */
  private async tooLateForRound(c: KeeperClaim, attempt: 1 | 2, fn: 'openCase' | 'refile', now: number): Promise<boolean> {
    const exp = this.caseExpiresAt(c);
    if (exp === undefined) return false;
    const round = await this.courtRoundS();
    const need = round + this.timing.courtSlackS;
    if (exp - now >= need) return false;
    if (this.once(c, `too-late-${attempt}`)) {
      this.alertClaim(
        c,
        'claim_stale',
        `${fn} skipped: the case expires in ${exp - now} s and one court round needs ${round} s plus ${this.timing.courtSlackS} s; it goes stale at expiresAt and the claim expires with its fee refunded`,
        { detail: { expiresAt: String(exp), roundS: String(round), slackS: String(this.timing.courtSlackS) } },
      );
    }
    return true;
  }

  /** Earlier of a case deadline (exclusive) and the case's expiresAt (also exclusive). */
  private openBy(c: KeeperClaim, deadline: number): number {
    const exp = this.caseExpiresAt(c);
    return exp !== undefined && exp < deadline ? exp : deadline;
  }

  /**
   * Frees an expired case on Arbitrum: once expiresAt has passed, `markStale` moves a Received,
   * Opened or RefilePending case to Stale and releases its open-case slot. NotExpired and
   * WrongState are races, never failures: WrongState ends the attempts for good, NotExpired waits
   * for the expiresAt it names. Returns true when the phase's own call must not run this tick.
   */
  private async markStale(c: KeeperClaim, now: number, opts: { expired?: boolean } = {}): Promise<boolean> {
    if (!c.received || c.staleAt !== undefined || c.done.includes('case-settled')) return false;
    const exp = this.caseExpiresAt(c);
    if (exp === undefined || now < exp) return false;
    const cv = await this.o.chains.caseOf(c.claimId);
    if (cv.state === CaseState.Stale) return true; // ClaimStale is on its way
    if (cv.state === CaseState.Ruled || cv.state === CaseState.Relayed) {
      this.once(c, 'case-settled'); // ruled: the ruling goes on as usual
      return false;
    }
    if (!STALEABLE.includes(cv.state)) return false;
    if (operatorHolds(this.control, c.claimId)) return true;
    // A final Kleros ruling nobody has executed yet still counts while Hedera has not expired the
    // claim: executeRuling (the Watching row's nudge) delivers it and frees the slot as well. A
    // dispute that cannot be read might hold one, so markStale waits for a read that answers.
    if (!opts.expired && cv.state === CaseState.Opened && cv.attempts > 0 && !expiryForced(this.control, c.claimId)) {
      const disputeId = cv.disputeIds[cv.attempts - 1]!;
      const k = await this.finalRuling(disputeId);
      if (k.state !== 'none') {
        let why = `Kleros dispute ${disputeId} is in its execution period; executeRuling goes first and markStale waits`;
        if (k.state === 'unread') {
          why = `Kleros dispute ${disputeId} could not be read (${k.error}), so a final ruling there cannot be ruled out; markStale waits until it can be read`;
          this.noteUnread(c, `Kleros dispute ${disputeId} could not be read (${k.error})`, now);
        }
        this.alertClaim(c, 'expiry_race', `the case expired at ${exp} but ${why}. To mark it stale anyway: keeper-ctl expire ${c.claimId}`, {
          links: [this.links.courtCase(disputeId.toString())],
        });
        return false;
      }
    }
    const r = await this.tryCall(c, rowOf(phaseOf(c)), { chain: 'arbitrum', contract: 'case', fn: 'markStale', args: [c.claimId] }, now, {
      retryEveryS: 300,
      benign: ['NotExpired', 'WrongState'],
    });
    if (r?.kind === 'reverted') {
      if (r.error === 'WrongState') {
        this.once(c, 'case-settled');
      } else if (r.error === 'NotExpired') {
        const at = Number(r.args?.[0] ?? 0);
        if (at > 0) {
          c.caseExpiresAt = at;
          this.book.save(c);
        }
      } else {
        this.alertClaim(c, 'call_failed', `markStale reverted with ${r.error ?? 'no reason'}; the case keeps its open-case slot until it goes through`);
      }
    } else if (r?.kind === 'ok' || r?.kind === 'pending') {
      this.log(`claim ${c.claimId}: case expired at ${exp}; markStale sent to free its slot`);
    }
    return true;
  }

  private async preChecked(c: KeeperClaim, row: Row, now: number): Promise<void> {
    if (this.claimsParams === undefined) return;
    const claim = await this.o.chains.getClaim(c.claimId);
    if (claim.status !== ClaimStatus.PreChecked) return;
    c.preCheckedAt = Number(claim.preCheckedAt);
    // The contest is still open at the boundary second.
    if (now <= c.preCheckedAt + this.claimsParams.contestWindow) return;
    if (this.held(c)) return;
    await this.tryCall(c, row, { chain: 'hedera', contract: 'claims', fn: 'closeUncontested', args: [c.claimId] }, now);
  }

  private async contested(c: KeeperClaim, row: Row, now: number): Promise<void> {
    const claim = await this.o.chains.getClaim(c.claimId);
    if (claim.status !== ClaimStatus.Contested || this.held(c)) return;
    const r = await this.tryCall(c, row, { chain: 'hedera', contract: 'claims', fn: 'sendToCourt', args: [c.claimId] }, now);
    if (r?.kind === 'reverted' && (r.error === 'LinkShort' || r.error === 'NativeShort')) {
      this.alertClaim(c, 'link_low', `sendToCourt needs CCIP fee funds on the claims contract (${r.error})`);
    }
  }

  private async sent(c: KeeperClaim, row: Row, now: number): Promise<void> {
    if (this.mode === BridgeMode.None || c.outbound.every((m) => m.messageId === ZERO32)) return this.relayClaimOneLeg(c, row, now);
    if (await this.readExec(c, c.outbound, 'arbitrum', now)) this.book.save(c);
    if (c.received) {
      // Delivered needs both proofs: our receive event and the OffRamp's Success for that message.
      const st = await this.o.chains.execState('arbitrum', c.received.messageId);
      if (st === ExecutionState.Success) {
        c.deliveredAt = c.received.at;
        this.book.save(c);
      }
      return;
    }
    const dropped = c.outbound.find((m) => m.successSeenAt !== undefined && now - m.successSeenAt >= this.timing.deliveredGraceS);
    if (dropped) {
      this.alertClaim(c, 'delivered_not_recorded', `message ${dropped.messageId} executed on Arbitrum but no ClaimReceived followed; check peer and selector. Not resent`, {
        links: [this.links.ccipMessage(dropped.messageId)],
      });
    }
    // Resend only when every copy is still Untouched: never on InProgress or Success.
    const last = c.outbound.at(-1);
    if (!last || c.outbound.some((m) => m.state !== ExecutionState.Untouched)) return;
    if (now - last.sentAt < this.timing.resendWaitS) return;
    if (this.claimsParams === undefined) return;
    const claim = await this.o.chains.getClaim(c.claimId);
    if (claim.status !== ClaimStatus.AtCourt) return;
    if (claim.sendCount >= this.claimsParams.maxSends) {
      this.alertClaim(c, 'sends_exhausted', `all ${this.claimsParams.maxSends} sends used and none delivered; gate decision`, {
        links: c.outbound.map((m) => this.links.ccipMessage(m.messageId)),
      });
      return;
    }
    if (now < Number(claim.lastSendAt) + this.claimsParams.resendGap || this.held(c)) return;
    await this.tryCall(c, row, { chain: 'hedera', contract: 'claims', fn: 'resend', args: [c.claimId] }, now, { retryEveryS: 300 });
  }

  /**
   * Reads the destination OffRamp state of each message; alerts on Failure. Returns true when a
   * state changed (so the caller journals a snapshot only then).
   */
  private async readExec(c: KeeperClaim, msgs: BridgeMsg[], destination: Chain, now: number): Promise<boolean> {
    let changed = false;
    for (const m of msgs) {
      if (m.messageId === ZERO32) continue;
      const st = await this.o.chains.execState(destination, m.messageId);
      if (m.state !== st) changed = true;
      m.state = st;
      if (st === ExecutionState.Success && m.successSeenAt === undefined) {
        m.successSeenAt = now;
        changed = true;
      }
      if (st === ExecutionState.Failure) {
        const side = destination === 'arbitrum' ? 'outbound message' : 'ruling message';
        this.alertClaim(c, 'exec_failure', `${side} ${m.messageId} failed on the ${destination === 'arbitrum' ? 'Arbitrum' : 'Hedera'} OffRamp; execute it by hand as "A CCIP message failed on an OffRamp" in services/keeper/RUNBOOK.md says`, {
          links: [this.links.ccipMessage(m.messageId)],
          detail: { messageId: m.messageId, sendNo: String(m.sendNo) },
        });
      }
    }
    return changed;
  }

  /** No CCIP: hand the payload to the case contract as the trusted relay. */
  private async relayClaimOneLeg(c: KeeperClaim, row: Row, now: number): Promise<void> {
    if (c.received || this.held(c)) return;
    const cv = await this.o.chains.caseOf(c.claimId);
    if (cv.state !== CaseState.None) return;
    const claim = await this.o.chains.getClaim(c.claimId);
    if (claim.status !== ClaimStatus.AtCourt) return;
    const payload = encodeClaimToCourt({
      version: 1,
      claimId: c.claimId,
      platform: claim.platform,
      shop: claim.shop,
      gap: claim.gap,
      answer: claim.answer,
      refs: claim.refs,
      packHash: claim.packHash,
      basketUsdc: claim.basketUsdc,
      netLossUsdc: claim.netLossUsdc,
      filedAt: claim.filedAt,
    });
    const r = await this.tryCall(c, row, { chain: 'arbitrum', contract: 'case', fn: 'relayClaim', args: [payload] }, now, { retryEveryS: 120 });
    if (r?.kind === 'reverted') this.alertClaim(c, 'one_leg_manual', `relayClaim reverted with ${r.error ?? 'no reason'}; relay it by hand`);
  }

  /**
   * Evidence for an attempt, built once and kept. 'none' when it can never be built: the documents
   * are fixed by packHash on chain, so a rebuild fails the same way, and the case goes to court
   * without our evidence rather than not at all. Callers check the hold themselves.
   */
  private async ensureEvidence(c: KeeperClaim, attempt: 1 | 2, now: number): Promise<'ok' | 'retry' | 'none'> {
    if (c.evidence?.[String(attempt)] && this.book.evidenceText(c.claimId, attempt) !== undefined) return 'ok';
    if (c.done.includes(`evidence-failed-${attempt}`)) return 'none';
    if (!c.received) return 'retry';
    const t = c.tries[`evidence${attempt}`];
    if (t && now - t.lastAt < 60) return 'retry';
    const externalId = externalIdOf(this.o.chains, c.claimId, attempt);
    const r = await this.o.evidence.build({ claimId: c.claimId, payload: c.received.payload, attempt, externalId });
    c.tries[`evidence${attempt}`] = { count: (t?.count ?? 0) + (r.ok ? 0 : 1), lastAt: now };
    if (r.ok) {
      this.book.saveEvidence(c, attempt, r.text, r.sha256);
      return 'ok';
    }
    c.lastError = `evidence ${attempt}: ${r.message}`;
    c.lastErrorAt = now;
    if (r.kind === 'transient') {
      this.book.save(c);
      if (now - (milestoneOf(c) ?? now) >= 600) this.alertClaim(c, 'evidence_failed', `evidence for attempt ${attempt} not ready: ${r.message}`);
      return 'retry';
    }
    const kind: AlertKind = r.kind === 'hash_mismatch' ? 'evidence_hash_mismatch' : r.kind === 'too_large' ? 'evidence_too_large' : 'evidence_failed';
    c.done.push(`evidence-failed-${attempt}`);
    this.book.save(c);
    this.alertClaim(
      c,
      kind,
      `${r.message}; the documents are fixed on chain, so the keeper does not retry. The case goes to court without our evidence for attempt ${attempt}; post it by hand on the court page if it can be written`,
    );
    return 'none';
  }

  private async delivered(c: KeeperClaim, row: Row, now: number): Promise<void> {
    if (!c.received || this.caseParams === undefined || this.held(c)) return;
    const cv = await this.o.chains.caseOf(c.claimId);
    if (cv.state !== CaseState.Received) return;
    const deadline = this.openBy(c, Number(cv.receivedAt) + this.caseParams.caseDeadline);
    if (now >= deadline) return; // opening now would only mark it stale
    if (await this.tooLateForRound(c, 1, 'openCase', now)) return;
    const ev = await this.ensureEvidence(c, 1, now);
    if (ev === 'retry' && now < deadline - this.timing.openWithoutEvidenceS) return;
    const [pool, cost, open] = [await this.o.chains.feePool(), await this.o.chains.costNow(), await this.o.chains.openCases()];
    if (pool < cost) {
      this.alertClaim(c, 'fee_pool_low', `fee pool ${pool} wei is below the arbitration cost ${cost}; run fundFeePool under keeper-ctl pause`);
      return;
    }
    if (open >= this.caseParams.maxOpenCases) {
      this.alertClaim(c, 'open_cases_near_cap', `${open} open cases, cap ${this.caseParams.maxOpenCases}; openCase waits`);
      return;
    }
    const r = await this.tryCall(c, row, { chain: 'arbitrum', contract: 'case', fn: 'openCase', args: [c.received.payload] }, now);
    if (r?.kind === 'reverted') {
      if (r.error === 'FeePoolLow') this.alertClaim(c, 'fee_pool_low', 'openCase reverted FeePoolLow; fund the pool');
      else if (r.error === 'CapReached') this.alertClaim(c, 'open_cases_near_cap', 'openCase reverted CapReached');
      else this.alertClaim(c, 'call_failed', `openCase reverted with ${r.error ?? 'no reason'}`);
    }
  }

  private async opened(c: KeeperClaim, row: Row, now: number): Promise<void> {
    const a = currentAttempt(c);
    if (!a || a.evidenceAt !== undefined) return;
    if (now >= a.openedAt + 900) {
      if (this.once(c, `evidence-missed-${a.attempt}`)) {
        this.alertClaim(c, 'evidence_missed', `no evidence posted in the 15-min evidence period of dispute ${a.disputeId}`, {
          links: [this.links.courtCase(a.disputeId)],
        });
      }
      // The court goes on without it: keep reading the ruling and nudging.
      return this.watching(c, row, now);
    }
    if (this.held(c)) return;
    const ev = await this.ensureEvidence(c, a.attempt, now);
    if (ev !== 'ok') return;
    const text = this.book.evidenceText(c.claimId, a.attempt)!;
    const r = await this.tryCall(
      c,
      row,
      { chain: 'arbitrum', contract: 'evidence', fn: 'submitEvidence', args: [BigInt(a.externalId), text] },
      now,
      { key: `submitEvidence${a.attempt}` },
    );
    if (r?.kind === 'ok') {
      a.evidenceAt = now;
      a.evidenceTx = r.hash;
      this.book.save(c);
    }
  }

  private async watching(c: KeeperClaim, _row: Row, now: number): Promise<void> {
    const a = currentAttempt(c);
    if (!a) return;
    const disputeId = BigInt(a.disputeId);
    let d: DisputeInfo | undefined;
    const since = now - a.openedAt;
    const lastRead = c.lastRuling?.attempt === a.attempt ? c.lastRuling.at : undefined;
    if (since >= this.timing.rulingReadFromS && (lastRead === undefined || now - lastRead >= this.timing.rulingReadEveryS)) {
      const r = await this.o.chains.currentRuling(disputeId);
      d = this.o.chains.disputeViews ? await this.o.chains.dispute(disputeId).catch(() => undefined) : undefined;
      c.lastRuling = { attempt: a.attempt, ruling: r.ruling.toString(), tied: r.tied, overridden: r.overridden, at: now };
      this.book.save(c);
      // A round starts tied at 0; only an untied 0, or a tie that survived the vote, is a refusal.
      const refusal = r.ruling === 0n && (!r.tied || (d !== undefined && d.period >= 3));
      if (a.attempt === 1 && refusal && this.once(c, 'zero-early-1')) {
        this.alertClaim(c, 'ruling_zero_early', `dispute ${a.disputeId} reads ruling 0 on attempt 1; read the jurors' reason. Refile follows RefileNeeded after the hold unless keeper-ctl hold`, {
          links: [this.links.courtCase(a.disputeId)],
        });
      }
      if (r.overridden && this.once(c, `overridden-${a.attempt}`)) {
        this.alertClaim(c, 'appeal_contribution', `dispute ${a.disputeId} ruling is overridden by appeal funding; operator decides on a counter-fund`, {
          links: [this.links.courtCase(a.disputeId)],
        });
      }
    }
    if (!this.held(c) && this.canSend('arbitrum', 'nudge', now)) await this.nudge(c, a, d, now);
  }

  /** Permissionless Kleros calls when a period is overdue or nobody has drawn jurors. Never stakes or appeals. */
  private async nudge(c: KeeperClaim, a: CourtAttempt, d: DisputeInfo | undefined, now: number): Promise<void> {
    const disputeId = BigInt(a.disputeId);
    if (!this.o.chains.disputeViews) return; // the local mock arbitrator has no periods to nudge
    const info = d ?? (await this.o.chains.dispute(disputeId).catch(() => undefined));
    if (info === undefined) return; // unreadable this tick: nudges only ever wait
    const row = rowOf('Watching');
    const after = this.timing.nudgeAfterS;
    const send = async (fn: string, contract: KeeperCall['contract'], args: readonly unknown[], marker: string) => {
      if (c.done.includes(marker)) return;
      const r = await this.tryCall(c, row, { chain: 'arbitrum', contract, fn, args }, now, { retryEveryS: 120, key: `nudge-${fn}` });
      if (r?.kind === 'ok' || r?.kind === 'pending') {
        this.once(c, marker);
        this.alertClaim(c, 'kleros_nudged', `called ${fn} for dispute ${a.disputeId}`, { links: [this.links.courtCase(a.disputeId)] });
      }
    };
    if (info.period < 4) {
      const limit = info.timesPerPeriod[info.period] ?? 0;
      if (now > info.lastPeriodChange + limit + after) {
        await send('passPeriod', 'core', [disputeId], `pass-${a.disputeId}-${info.period}-${info.lastPeriodChange}`);
      }
    } else if (!info.ruled && now > info.lastPeriodChange + after) {
      await send('executeRuling', 'core', [disputeId], `exec-${a.disputeId}`);
    }
    if (!a.drawSeen && info.period === 0 && now - a.openedAt >= 1800) {
      const s = await this.o.chains.sortition().catch(() => undefined);
      if (s === undefined) return;
      if (s.phase === 2) await send('draw', 'core', [disputeId, 20n], `draw-${a.disputeId}-${s.lastPhaseChange}`);
      else await send('passPhase', 'sortition', [], `phase-${s.phase}-${s.lastPhaseChange}`);
    }
  }

  private async refilePending(c: KeeperClaim, row: Row, now: number): Promise<void> {
    if (!c.received || c.refileNeededAt === undefined || this.caseParams === undefined) return;
    if (now < c.refileNeededAt + this.timing.refileHoldS || this.held(c)) return;
    const cv = await this.o.chains.caseOf(c.claimId);
    if (cv.state !== CaseState.RefilePending) return;
    const deadline = this.openBy(c, Number(cv.ruledAt) + this.caseParams.caseDeadline);
    if (now >= deadline) return; // refiling now would only mark it stale
    if (await this.tooLateForRound(c, 2, 'refile', now)) return;
    const ev = await this.ensureEvidence(c, 2, now);
    if (ev === 'retry' && now < deadline - this.timing.openWithoutEvidenceS) return;
    const r = await this.tryCall(c, row, { chain: 'arbitrum', contract: 'case', fn: 'refile', args: [c.received.payload] }, now);
    if (r?.kind === 'reverted') this.alertClaim(c, 'call_failed', `refile reverted with ${r.error ?? 'no reason'}`);
  }

  private async ruledArb(c: KeeperClaim, row: Row, now: number): Promise<void> {
    const rf = c.rulingFinal;
    if (!rf || this.mode === undefined || this.held(c)) return;
    if (this.mode === BridgeMode.Both) {
      const cv = await this.o.chains.caseOf(c.claimId);
      if (cv.state !== CaseState.Ruled) return;
      await this.relayRuling(c, row, now);
      return;
    }
    // One-leg modes: the ruling goes to Hedera from the ruling relayer key.
    const claim = await this.o.chains.getClaim(c.claimId);
    if (claim.status !== ClaimStatus.AtCourt) return;
    const r = await this.tryCall(
      c,
      row,
      { chain: 'hedera', contract: 'claims', fn: 'recordRuling', args: [c.claimId, BigInt(rf.disputeId), rf.ruling, rf.attempts] },
      now,
    );
    if (r?.kind === 'reverted') this.alertClaim(c, 'one_leg_manual', `recordRuling reverted with ${r.error ?? 'no reason'}`);
  }

  /** relayRuling paid in LINK; if the case contract is short of LINK, paid in ETH from the ops key. */
  private async relayRuling(c: KeeperClaim, row: Row, now: number, opts: { retryEveryS?: number; maxTries?: number } = {}): Promise<void> {
    const r = await this.tryCall(c, row, { chain: 'arbitrum', contract: 'case', fn: 'relayRuling', args: [c.claimId] }, now, opts);
    if (r?.kind !== 'reverted' || r.error !== 'InsufficientLink') return;
    this.alertClaim(c, 'link_low', 'the case contract is short of LINK for relayRuling; paying this relay in ETH from the ops key');
    const q = await this.o.chains.quoteRelay(c.claimId);
    const value = (q.native * 11n) / 10n; // surplus is refunded
    await this.tryCall(c, row, { chain: 'arbitrum', contract: 'case', fn: 'relayRuling', args: [c.claimId], value }, now, {
      ...opts,
      key: 'relayRulingNative',
    });
  }

  private async relayed(c: KeeperClaim, row: Row, now: number): Promise<void> {
    if (await this.readExec(c, c.inbound, 'hedera', now)) this.book.save(c);
    const ignored = c.rulingIgnored ?? [];
    for (const ig of ignored) {
      if (!this.once(c, `ignored-${ig.messageId ?? ig.at}`)) continue;
      this.alertClaim(c, 'delivered_not_recorded', `Hedera ignored ruling message ${ig.messageId ?? '?'} (reason ${ig.reason}); not resent, the operator decides`, {
        ...(ig.messageId ? { links: [this.links.ccipMessage(ig.messageId)] } : {}),
        detail: { reason: String(ig.reason) },
      });
    }
    const dropped = c.inbound.find(
      (m) => m.successSeenAt !== undefined && now - m.successSeenAt >= this.timing.deliveredGraceS && !ignored.some((ig) => ig.messageId === m.messageId),
    );
    if (dropped) {
      this.alertClaim(c, 'delivered_not_recorded', `ruling message ${dropped.messageId} executed on Hedera but no RulingReceived or RulingIgnored followed`, {
        links: [this.links.ccipMessage(dropped.messageId)],
      });
    }
    const last = c.inbound.at(-1);
    if (!last || c.inbound.some((m) => m.state !== ExecutionState.Untouched)) return;
    if (now - last.sentAt < this.timing.resendWaitS || this.caseParams === undefined) return;
    const cv = await this.o.chains.caseOf(c.claimId);
    if (cv.sendCount >= this.caseParams.maxSends) {
      this.alertClaim(c, 'sends_exhausted', `all ${this.caseParams.maxSends} ruling relays used and none delivered; gate decision`, {
        links: c.inbound.map((m) => this.links.ccipMessage(m.messageId)),
      });
      return;
    }
    if (now < Number(cv.lastSendAt) + this.caseParams.resendGap || this.held(c)) return;
    await this.relayRuling(c, row, now, { retryEveryS: 300 });
  }

  private async ruledHedera(c: KeeperClaim, row: Row, now: number): Promise<void> {
    const claim = await this.o.chains.getClaim(c.claimId);
    if (claim.status !== ClaimStatus.Ruled || this.held(c)) return;
    await this.tryCall(c, row, { chain: 'hedera', contract: 'claims', fn: 'settle', args: [c.claimId] }, now);
  }

  private async terminal(c: KeeperClaim, now: number): Promise<void> {
    // Hedera's court-stage expiry comes after the case's expiresAt, so an expired claim may still
    // hold an open-case slot on Arbitrum (say the keeper was down across both): free it.
    if (c.terminal === 'Expired') await this.markStale(c, now, { expired: true });
    if (c.terminal === 'Settled' && c.shop && !c.done.includes('withdraw-due')) {
      const credit = await this.o.chains.creditOf(c.shop);
      if (credit > 0n) {
        const t = this.o.vaultToken;
        this.alertClaim(c, 'withdraw_due', `shop ${c.shop} has ${credit} µ${t.symbol} of credit${t.mode === 'mock' ? ' (testnet mock)' : ''}; run the shop's withdraw-credit`);
      }
      this.once(c, 'withdraw-due');
    }
  }

  // ------------------------------------------------------------------ bridge-wide

  private async handleGlobalEvents(now: number): Promise<void> {
    const events = this.book.globalEvents;
    for (; this.handledGlobal < events.length; this.handledGlobal++) {
      const e = events[this.handledGlobal]!;
      if (e.name === 'ClaimRejected') {
        const id = String(e.args.messageId).toLowerCase();
        const c = [...this.book.claims.values()].find((x) => x.outbound.some((m) => m.messageId === id));
        if (c) {
          this.alertClaim(c, 'delivered_not_recorded', `Arbitrum rejected message ${id} (reason ${String(e.args.reason)}); not resent`, {
            links: [this.links.ccipMessage(id as Hex)],
          });
        }
      } else if (e.name === 'Contribution' || e.name === 'ChoiceFunded') {
        const disputeId = String(e.args._coreDisputeID);
        const claimId = this.book.claimOfDispute(disputeId);
        if (!claimId) continue;
        const c = this.book.claims.get(claimId)!;
        let timeLeft = 'unknown';
        const info = await this.o.chains.dispute(BigInt(disputeId)).catch(() => undefined);
        if (info && info.period === 3) timeLeft = `${Math.max(0, info.lastPeriodChange + (info.timesPerPeriod[3] ?? 0) - now)} s`;
        this.alertClaim(c, 'appeal_contribution', `appeal funding on dispute ${disputeId}; the keeper never funds appeals, the operator decides`, {
          links: [this.links.courtCase(disputeId)],
          detail: {
            event: e.name,
            choice: String(e.args._choice),
            amount: e.args._amount !== undefined ? String(e.args._amount) : '',
            contributor: e.args._contributor !== undefined ? String(e.args._contributor) : '',
            timeLeft,
          },
        });
      } else if (e.name === 'BridgeModeSet') {
        this.mode = await this.o.chains.bridgeMode();
      }
    }
  }

  private async checkLevels(): Promise<void> {
    const ch = this.o.chains;
    const [pool, cost, open, lv] = [await ch.feePool(), await ch.costNow(), await ch.openCases(), await ch.levels()];
    this.health.levels = {
      feePool: pool.toString(),
      costNow: cost.toString(),
      openCases: open,
      opsHederaWeibar: lv.opsHederaWeibar.toString(),
      opsArbWei: lv.opsArbWei.toString(),
      claimsLink: lv.claimsLink.toString(),
      caseLink: lv.caseLink.toString(),
      ...(lv.claimsFeeToken !== undefined ? { claimsFeeToken: lv.claimsFeeToken } : {}),
      ...(lv.claimsNativeWeibar !== undefined ? { claimsNativeWeibar: lv.claimsNativeWeibar.toString() } : {}),
    };
    if (pool < 3n * cost) this.alert({ kind: 'fee_pool_low', hint: `fee pool ${pool} wei is under 3 x arbitration cost ${cost}` });
    if (this.caseParams && open >= this.caseParams.maxOpenCases - 2) {
      this.alert({ kind: 'open_cases_near_cap', hint: `${open} open cases of ${this.caseParams.maxOpenCases}` });
    }
    const floors = this.o.floors ?? DEFAULT_FLOORS;
    if (lv.opsHederaWeibar < floors.opsHederaWeibar) {
      this.alert({
        kind: 'gas_low',
        subject: 'ops-hedera',
        hint: `ops-hedera holds ${units(lv.opsHederaWeibar)} HBAR, under its floor of ${units(floors.opsHederaWeibar)} HBAR; top it up before the keeper's Hedera sends (sendToCourt, settle, expireClaim) start failing`,
        detail: { weibar: lv.opsHederaWeibar.toString(), floorWeibar: floors.opsHederaWeibar.toString() },
      });
    }
    if (lv.opsArbWei < floors.opsArbWei) {
      this.alert({
        kind: 'gas_low',
        subject: 'ops-arb',
        hint: `ops-arb holds ${units(lv.opsArbWei)} ETH, under its floor of ${units(floors.opsArbWei)} ETH; top it up before openCase, evidence and relay sends start failing`,
        detail: { wei: lv.opsArbWei.toString(), floorWei: floors.opsArbWei.toString() },
      });
    }
    await this.checkClaimsFee(lv, floors);
    const open1 = this.book.open().find((c) => phaseOf(c) === 'RuledArb' || phaseOf(c) === 'Relayed');
    if (open1) {
      const q = await ch.quoteRelay(open1.claimId).catch(() => undefined);
      if (q && lv.caseLink < 3n * q.link) this.alert({ kind: 'link_low', subject: 'case', hint: `case contract LINK ${lv.caseLink} is under 3 x the relay quote ${q.link}` });
    }
    if (ch.hederaLagS) {
      const lag = await ch.hederaLagS();
      this.health.hederaLagS = lag;
      if (lag > 120) this.alert({ kind: 'mirror_lag', hint: `mirror node is ${lag} s behind` });
    }
  }

  /**
   * The claims contract pays each sendToCourt and resend's CCIP fee from its own balance, in HBAR
   * or LINK as its feeToken says, and reverts NativeShort or LinkShort below one send. Alerts
   * link_low (subject claims) under the floor, raised to 3 sends when a claim can be quoted.
   */
  private async checkClaimsFee(lv: Levels, floors: FundingFloors): Promise<void> {
    if (lv.claimsFeeToken === undefined) return;
    const native = BigInt(lv.claimsFeeToken) === 0n;
    const have = native ? lv.claimsNativeWeibar : lv.claimsLink;
    if (have === undefined) return;
    let floor = native ? floors.claimsFeeWeibar : floors.claimsFeeLink;
    const sample = this.book.open()[0] ?? [...this.book.claims.values()].at(-1);
    let quote: bigint | undefined;
    if (sample && this.o.chains.quoteSend) {
      const q = await this.o.chains.quoteSend(sample.claimId).catch(() => undefined);
      if (q && q.native === native && q.amount > 0n) {
        quote = q.amount;
        if (3n * q.amount > floor) floor = 3n * q.amount;
      }
    }
    if (floor === 0n || have >= floor) return;
    const unit = native ? 'HBAR' : 'LINK';
    const how = native ? 'fund it with fundNative()' : 'transfer LINK to it';
    this.alert({
      kind: 'link_low',
      subject: 'claims',
      hint:
        `the claims contract holds ${units(have)} ${unit} for CCIP fees, under its floor of ${units(floor)} ${unit}` +
        `${quote !== undefined ? ` (one send costs ${units(quote)} ${unit} now)` : ''}; sendToCourt and resend revert below one send, ${how}`,
      detail: { feeToken: native ? 'HBAR' : String(lv.claimsFeeToken), have: have.toString(), floor: floor.toString(), ...(quote !== undefined ? { quote: quote.toString() } : {}) },
    });
  }

  /** Journal view of one claim, for GET /claims/:claimId and keeper-ctl status. */
  view(claimId: string): Record<string, unknown> | undefined {
    const c = this.book.claims.get(claimId.toLowerCase());
    if (!c) return undefined;
    const lastAlert = this.o.alerter.latestFor(c.claimId);
    return {
      claimId: c.claimId,
      phase: phaseOf(c) as Phase,
      milestone: milestoneOf(c),
      held: this.held(c),
      autoHold: c.autoHold,
      filedAt: c.filedAt,
      preCheckedAt: c.preCheckedAt,
      outbound: c.outbound.map((m) => ({ ...m, link: this.links.ccipMessage(m.messageId) })),
      inbound: c.inbound.map((m) => ({ ...m, link: this.links.ccipMessage(m.messageId) })),
      received: c.received ? { messageId: c.received.messageId, at: c.received.at, payloadBytes: (c.received.payload.length - 2) / 2 } : undefined,
      attempts: c.attempts.map((a) => ({ ...a, link: this.links.courtCase(a.disputeId) })),
      rulingFinal: c.rulingFinal,
      lastRuling: c.lastRuling,
      tries: c.tries,
      lastError: c.lastError,
      lastErrorAt: c.lastErrorAt,
      lastAlert: lastAlert ? { kind: lastAlert.kind, at: new Date(lastAlert.raisedAt).toISOString() } : undefined,
    };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
}

function externalIdOf(chains: Chains, claimId: Hex, attempt: 1 | 2): bigint {
  // Same formula as the case contract's externalIdOf, computed locally.
  return externalIdUint(chains.arbChainId, chains.caseAddress, claimId, attempt);
}
