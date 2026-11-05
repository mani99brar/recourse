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
} from '@recourse/shared';
import type { Hex } from 'viem';
import type { Alert, AlertKind, Alerter } from './alerts.js';
import { ClaimBook, currentAttempt, isTerminal, milestoneOf, phaseOf } from './claims.js';
import { controlWindows, operatorHolds, readControl, releasedSince, type Control } from './control.js';
import type { EvidencePort } from './evidence.js';
import type { Journal } from './journal.js';
import { replayJournal } from './journal.js';
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
  Phase,
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
  /** Funding floors for the gas alerts. */
  floors?: { opsHederaWeibar: bigint; opsArbWei: bigint };
  log?: (line: string) => void;
  /** Explorer and court link builders for alerts. */
  links?: Partial<Links>;
}

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
  lastError?: string;
  paused: boolean;
  windowsActive: string[];
  mode?: BridgeMode;
  claimsParams?: ClaimsParams;
  caseParams?: CaseParams;
  paramsError?: string;
  cursors: { hedera?: string; arbitrum?: string };
  hederaLagS?: number;
  claimsByPhase: Record<string, number>;
  levels?: { feePool: string; costNow: string; openCases: number; opsHederaWeibar: string; opsArbWei: string; claimsLink: string; caseLink: string };
}

export class Keeper {
  readonly book: ClaimBook;
  readonly health: KeeperHealth = { paused: false, windowsActive: [], cursors: {}, claimsByPhase: {} };
  private readonly timing: Timing;
  private readonly links: Links;
  private control: Control = { paused: false, holds: {}, releases: {}, windows: [] };
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

  /** Loads the journal: terminal claims first, then open claims from their last state. */
  start(): void {
    const replay = replayJournal(this.o.stateDir);
    if (replay.badLines.length > 0) {
      this.o.alerter.raise({ kind: 'journal_error', hint: `journal lines ${replay.badLines.join(', ')} do not parse; run keeper-ctl rebuild` });
    }
    // Senders first: an intent signed before a crash is settled before anything new is sent.
    this.o.chains.load(replay.records);
    this.book.load(replay.records);
    this.o.alerter.load(replay.records);
    this.handledGlobal = this.book.globalEvents.length;
  }

  // ------------------------------------------------------------------ tick

  async tick(): Promise<void> {
    const now = this.now();
    this.health.lastTickAt = now;
    try {
      this.control = readControl(this.o.stateDir);
    } catch (err) {
      this.health.lastError = `control file unreadable: ${msg(err)}`;
    }
    const extra = controlWindows(this.control);
    this.windows = [...(this.o.windows ?? []), ...extra.windows];
    this.health.paused = this.control.paused;
    this.health.windowsActive = this.windows.filter((w) => w.from <= now && now < w.to).map((w) => `${w.chain}@${w.from}/${w.to}`);

    await this.refreshParams();
    await this.guard('resolve open transactions', () => this.o.chains.resolveOpen());
    await this.guard('hedera events', () => this.ingestHedera());
    await this.guard('arbitrum events', () => this.ingestArbitrum());
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
        this.health.lastError = `${c.claimId}: ${msg(err)}`;
        this.log(`claim ${c.claimId}: ${msg(err)}`);
      }
    }
    for (const c of this.book.claims.values()) if (isTerminal(c)) await this.guard('terminal', () => this.terminal(c, now));
    const counts: Record<string, number> = {};
    for (const c of this.book.claims.values()) counts[phaseOf(c)] = (counts[phaseOf(c)] ?? 0) + 1;
    this.health.claimsByPhase = counts;
    await this.o.alerter.flush();
  }

  private async guard(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.health.lastError = `${what}: ${msg(err)}`;
      this.log(`${what}: ${msg(err)}`);
      this.alert({ kind: 'rpc_down', hint: `${what} failed: ${msg(err)}` });
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
   * both cases); a PreChecked claim never. Returns true when the row's own call must not run.
   */
  private async expiry(c: KeeperClaim, now: number): Promise<boolean> {
    if (this.claimsParams === undefined) return false;
    const timeout = this.claimsParams.claimTimeout;
    // No claim expires before filedAt + claimTimeout, so skip the read until then.
    if (c.filedAt !== undefined && now <= c.filedAt + timeout) return false;
    const claim = await this.o.chains.getClaim(c.claimId);
    if (!canExpireClaim(claim, BigInt(timeout), BigInt(now))) return false;
    // A ruling still on its way to Hedera would arrive after expiry and be ignored: wait for it.
    let changed = false;
    let inFlight: Hex | undefined;
    for (const m of c.inbound) {
      const st = await this.o.chains.execState('hedera', m.messageId);
      if (m.state !== st) changed = true;
      m.state = st;
      if (st === ExecutionState.Untouched || st === ExecutionState.InProgress) inFlight ??= m.messageId;
    }
    if (changed) this.book.save(c);
    if (inFlight !== undefined) {
      this.alertClaim(c, 'expiry_race', `claim timeout passed while ruling message ${inFlight} is still in flight; expiry waits`, {
        links: [this.links.ccipMessage(inFlight)],
      });
      return true;
    }
    // One-leg modes: a final ruling not yet recorded goes first; the row's recordRuling runs.
    if (c.rulingFinal && c.rulingReceivedAt === undefined && this.mode !== undefined && this.mode !== BridgeMode.Both) {
      this.alertClaim(c, 'expiry_race', 'claim timeout passed with a final ruling not yet recorded on Hedera; recordRuling goes first');
      return false;
    }
    // Expiry is the escrow's way out, so a hold from some other call's failures does not stop it;
    // an operator hold, or a failed expiry, does.
    if (operatorHolds(this.control, c.claimId) || c.autoHold?.reason.startsWith('expireClaim')) return true;
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
  private async markStale(c: KeeperClaim, now: number): Promise<boolean> {
    if (!c.received || c.staleAt !== undefined || c.done.includes('case-settled')) return false;
    const exp = this.caseExpiresAt(c);
    if (exp === undefined || now < exp) return false;
    const cv = await this.o.chains.caseOf(c.claimId);
    if (cv.state === CaseState.Stale) return true; // ClaimStale is on its way
    if (cv.state === CaseState.Ruled || cv.state === CaseState.Relayed) {
      this.once(c, 'case-settled'); // ruled before it expired: the ruling goes on as usual
      return false;
    }
    if (!STALEABLE.includes(cv.state)) return false;
    if (operatorHolds(this.control, c.claimId)) return true;
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
        this.alertClaim(c, 'exec_failure', `${side} ${m.messageId} failed on the ${destination === 'arbitrum' ? 'Arbitrum' : 'Hedera'} OffRamp; see the stuck-message runbook`, {
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

  /** Evidence for an attempt, built once and kept. */
  private async ensureEvidence(c: KeeperClaim, attempt: 1 | 2, now: number): Promise<'ok' | 'retry' | 'blocked'> {
    if (c.evidence?.[String(attempt)] && this.book.evidenceText(c.claimId, attempt) !== undefined) return 'ok';
    if (c.autoHold) return 'blocked';
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
    if (r.kind === 'transient') {
      this.book.save(c);
      if (now - (milestoneOf(c) ?? now) >= 600) this.alertClaim(c, 'evidence_failed', `evidence for attempt ${attempt} not ready: ${r.message}`);
      return 'retry';
    }
    const kind: AlertKind = r.kind === 'hash_mismatch' ? 'evidence_hash_mismatch' : r.kind === 'too_large' ? 'evidence_too_large' : 'evidence_failed';
    this.hold(c, `evidence ${attempt}: ${r.message}`);
    this.alertClaim(c, kind, `${r.message}; claim held. Fix the documents, then keeper-ctl release ${c.claimId}`);
    return 'blocked';
  }

  private async delivered(c: KeeperClaim, row: Row, now: number): Promise<void> {
    if (!c.received || this.caseParams === undefined || this.held(c)) return;
    const cv = await this.o.chains.caseOf(c.claimId);
    if (cv.state !== CaseState.Received) return;
    const deadline = this.openBy(c, Number(cv.receivedAt) + this.caseParams.caseDeadline);
    if (now >= deadline) return; // opening now would only mark it stale
    const ev = await this.ensureEvidence(c, 1, now);
    if (ev === 'blocked') return;
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
      d = await this.o.chains.dispute(disputeId).catch(() => undefined);
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
    const info = d ?? (await this.o.chains.dispute(disputeId).catch(() => undefined));
    if (info === undefined) return; // the arbitrator does not expose dispute views (local mock)
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
    const ev = await this.ensureEvidence(c, 2, now);
    if (ev === 'blocked') return;
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
    if (c.terminal === 'Expired') await this.markStale(c, now);
    if (c.terminal === 'Settled' && c.shop && !c.done.includes('withdraw-due')) {
      const credit = await this.o.chains.creditOf(c.shop);
      if (credit > 0n) {
        this.alertClaim(c, 'withdraw_due', `shop ${c.shop} has ${credit} µUSDC of credit; run the shop's withdraw-credit`);
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
    };
    if (pool < 3n * cost) this.alert({ kind: 'fee_pool_low', hint: `fee pool ${pool} wei is under 3 x arbitration cost ${cost}` });
    if (this.caseParams && open >= this.caseParams.maxOpenCases - 2) {
      this.alert({ kind: 'open_cases_near_cap', hint: `${open} open cases of ${this.caseParams.maxOpenCases}` });
    }
    const floors = this.o.floors;
    if (floors && lv.opsHederaWeibar < floors.opsHederaWeibar) this.alert({ kind: 'gas_low', hint: `ops-hedera has ${lv.opsHederaWeibar} weibar` });
    if (floors && lv.opsArbWei < floors.opsArbWei) this.alert({ kind: 'gas_low', hint: `ops-arb has ${lv.opsArbWei} wei` });
    const open1 = this.book.open().find((c) => phaseOf(c) === 'RuledArb' || phaseOf(c) === 'Relayed');
    if (open1) {
      const q = await ch.quoteRelay(open1.claimId).catch(() => undefined);
      if (q && lv.caseLink < 3n * q.link) this.alert({ kind: 'link_low', hint: `case contract LINK ${lv.caseLink} is under 3 x the relay quote ${q.link}` });
    }
    if (ch.hederaLagS) {
      const lag = await ch.hederaLagS();
      this.health.hederaLagS = lag;
      if (lag > 120) this.alert({ kind: 'mirror_lag', hint: `mirror node is ${lag} s behind` });
    }
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
