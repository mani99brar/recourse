// Claim status as shown to people: one machine key per claim plus who acts next and by when.
// Pure: callers read the contracts (and the CCIP OffRamps) and pass the values in.

import type { Address, Hex } from 'viem';
import type { Claim } from './claim.js';
import { CaseState, ClaimStatus, ExecutionState } from './codes.js';

export const STATUS_KEYS = [
  'filed',
  'finding_made',
  'no_finding',
  'window_lapsed',
  'closed_uncontested',
  'contested',
  'at_court',
  'stuck',
  'refused_once',
  'ruled',
  'zero_twice_answer_applied',
  'unresolved',
  'settled',
  'expired',
  'closed_undrawn',
] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

export type NextActor = 'none' | 'anyone' | 'shop' | 'platform' | 'keeper' | 'court' | 'preCheckSigner';

export type NextCall =
  | 'recordPreCheck'
  | 'contest'
  | 'closeUncontested'
  | 'sendToCourt'
  | 'openCase'
  | 'refile'
  | 'resend'
  | 'relayRuling'
  | 'manualExecute'
  | 'expireClaim'
  | 'settle'
  | 'withdrawCredit';

export interface StatusView {
  statusKey: StatusKey;
  nextActor: NextActor;
  nextCall: NextCall | null;
  /** Unix seconds; inclusive (the action is still open at that second) except caseDeadline ones, which are exclusive. */
  deadline: bigint | null;
}

/** `RecourseCase.caseOf(claimId)` plus the KlerosCore reads for the current dispute. */
export interface CaseView {
  state: CaseState;
  payloadHash: Hex;
  receivedAt: bigint;
  attempts: number;
  disputeIds: readonly [bigint, bigint];
  templateIds: readonly [bigint, bigint];
  ruling: number;
  ruledAt: bigint;
  sendCount: number;
  lastSendAt: bigint;
  lastMessageId: Hex;
  /**
   * `RecourseCase.expiresAt(claimId)`: filedAt + Arbitrum's claimTimeout (0 when unknown). From this
   * second on the case cannot open or refile and anyone may `markStale` it. Optional: when absent,
   * only the caseDeadline rules apply.
   */
  expiresAt?: bigint;
  /** KlerosCore dispute period (0 evidence, 1 commit, 2 vote, 3 appeal, 4 execution). */
  period?: number;
  currentRuling?: bigint;
  tied?: boolean;
  overridden?: boolean;
}

export type BridgeDirection = 'toArbitrum' | 'toHedera';

/** One CCIP message of the claim, with the destination OffRamp's execution state. */
export interface BridgeView {
  messageId: Hex;
  direction: BridgeDirection;
  /** 1 for the first send on a leg, 2 for the first resend, ... */
  sendNo: number;
  executionState: ExecutionState;
  /** Unix seconds. */
  sentAt: bigint;
}

/** Live values from Claims `params()`, Case `params()` and the static stuck threshold. */
export interface LiveParams {
  contestWindow: bigint;
  claimTimeout: bigint;
  resendGap: bigint;
  maxSends: number;
  caseDeadline: bigint;
  maxOpenCases: number;
  stuckAfter: bigint;
}

/** Claim fields plus whether a batch draw left it out (false when unbatched). */
export type ClaimForStatus = Pick<
  Claim,
  'status' | 'answer' | 'ruling' | 'filedAt' | 'preCheckedAt'
> & { undrawn: boolean; shop?: Address; platform?: Address };

function latest(views: readonly BridgeView[], direction: BridgeDirection): BridgeView | undefined {
  let best: BridgeView | undefined;
  for (const v of views) if (v.direction === direction && (best === undefined || v.sendNo > best.sendNo)) best = v;
  return best;
}

function legStuck(v: BridgeView | undefined, p: LiveParams, now: bigint): 'failed' | 'waiting' | undefined {
  if (v === undefined) return undefined;
  if (v.executionState === ExecutionState.Failure) return 'failed';
  if (v.executionState === ExecutionState.Untouched && now > v.sentAt + p.stuckAfter) return 'waiting';
  return undefined;
}

/**
 * Second after which Hedera's `expireClaim` succeeds (it needs now > this), or null when the claim
 * cannot expire: a Filed claim counts from `filedAt`, a Contested or AtCourt claim from
 * `preCheckedAt`. PreChecked claims never expire; they close uncontested after the window.
 */
export function claimExpiresAfter(
  claim: Pick<Claim, 'status' | 'filedAt' | 'preCheckedAt'>,
  claimTimeout: bigint,
): bigint | null {
  if (claim.status === ClaimStatus.Filed) return claim.filedAt + claimTimeout;
  if (claim.status === ClaimStatus.Contested || claim.status === ClaimStatus.AtCourt) return claim.preCheckedAt + claimTimeout;
  return null;
}

/** True when Hedera's `expireClaim` would succeed at `now` (strictly after `claimExpiresAfter`). */
export function canExpireClaim(
  claim: Pick<Claim, 'status' | 'filedAt' | 'preCheckedAt'>,
  claimTimeout: bigint,
  now: bigint,
): boolean {
  const after = claimExpiresAfter(claim, claimTimeout);
  return after !== null && now > after;
}

/** Arbitrum's `expiresAt` when known (non-zero). */
function arbExpiry(c: CaseView): bigint | null {
  return c.expiresAt !== undefined && c.expiresAt > 0n ? c.expiresAt : null;
}

/** Earlier of an exclusive caseDeadline and Arbitrum's (also exclusive) expiresAt. */
function openBy(deadline: bigint, c: CaseView): bigint {
  const e = arbExpiry(c);
  return e !== null && e < deadline ? e : deadline;
}

/** True when the Arbitrum case can no longer move: Stale, or its open/refile window has closed. */
function caseDead(c: CaseView | null, p: LiveParams, now: bigint): boolean {
  if (c === null) return false;
  if (c.state === CaseState.Stale) return true;
  if (c.state === CaseState.Received && now >= openBy(c.receivedAt + p.caseDeadline, c)) return true;
  if (c.state === CaseState.RefilePending && now >= openBy(c.ruledAt + p.caseDeadline, c)) return true;
  return false;
}

/**
 * True while a ruling can still reach Hedera and settle an AtCourt claim. Hedera applies a ruling
 * to an AtCourt claim whenever it lands, timeout or not, so expiry would throw it away; the keeper
 * waits in the same states (machine.ts pendingRuling):
 * - the case is Ruled on Arbitrum and not yet relayed;
 * - a return message is Untouched or InProgress, or it failed on the Hedera OffRamp, where anyone
 *   can still execute it by hand; a Relayed case whose message is not read yet counts too;
 * - the case is Opened and its Kleros dispute is in the execution period: the ruling is final and
 *   executeRuling delivers it (the deployed RecourseCase takes a ruling at any time while Opened).
 * Not pending: any return message that succeeded (Hedera recorded or ignored it), or a case that is
 * still being decided.
 */
function rulingOnItsWay(c: CaseView | null, views: readonly BridgeView[]): boolean {
  if (c !== null && c.state === CaseState.Ruled) return true;
  const backs = views.filter((v) => v.direction === 'toHedera');
  if (backs.length > 0) return !backs.some((v) => v.executionState === ExecutionState.Success);
  if (c === null) return false;
  if (c.state === CaseState.Relayed) return true;
  return c.state === CaseState.Opened && c.attempts > 0 && c.period === 4;
}

/** What the caller knows about how current its reads are. */
export interface StatusOptions {
  /**
   * True when the Arbitrum case has not been read recently, so `caseView` (or its absence, which
   * otherwise means "not received yet") may be behind the chain: a ruling may be on its way that
   * the caller cannot see. Past the timeout an AtCourt claim then gets no expiry advice unless the
   * case it did read can no longer move (Stale, or past its open or refile deadline).
   */
  caseLate?: boolean;
}

/** Status of one claim. First matching row wins. */
export function deriveStatus(
  claim: ClaimForStatus,
  caseView: CaseView | null,
  bridgeViews: readonly BridgeView[],
  p: LiveParams,
  now: bigint,
  opts: StatusOptions = {},
): StatusView {
  const s = claim.status;
  const view = (statusKey: StatusKey, nextActor: NextActor, nextCall: NextCall | null, deadline: bigint | null = null) => ({
    statusKey,
    nextActor,
    nextCall,
    deadline,
  });

  if (s === ClaimStatus.Expired) return view('expired', 'none', null);
  if ((s === ClaimStatus.Ruled || s === ClaimStatus.Settled) && claim.ruling === 0 && claim.answer === 0) {
    return s === ClaimStatus.Ruled ? view('unresolved', 'anyone', 'settle') : view('unresolved', 'none', null);
  }
  if (s === ClaimStatus.Ruled && claim.ruling === 0) return view('zero_twice_answer_applied', 'anyone', 'settle');
  if (s === ClaimStatus.Ruled) return view('ruled', 'anyone', 'settle');
  if (s === ClaimStatus.Settled) return view('settled', 'shop', 'withdrawCredit');
  if (s === ClaimStatus.Closed && claim.undrawn) return view('closed_undrawn', 'shop', 'withdrawCredit');
  if (s === ClaimStatus.Closed) return view('closed_uncontested', 'shop', 'withdrawCredit');

  if (s === ClaimStatus.AtCourt) {
    const expiry = claim.preCheckedAt + p.claimTimeout;
    const expired = now > expiry;
    const lastBack = latest(bridgeViews, 'toHedera');
    const back = legStuck(lastBack, p, now);
    const out = legStuck(latest(bridgeViews, 'toArbitrum'), p, now);
    const dead = caseDead(caseView, p, now);
    // Past the timeout with a ruling still on its way, or a case read too long ago to tell: never
    // advise expiry, which would discard the ruling. No deadline either: the timeout has passed,
    // and showing it reads as "can be ended after".
    if (expired && !dead && (opts.caseLate === true || rulingOnItsWay(caseView, bridgeViews))) {
      if (back === 'failed') return view('stuck', 'anyone', 'manualExecute');
      if (back === 'waiting') return view('stuck', 'anyone', 'relayRuling');
      const key: StatusKey = caseView !== null && caseView.attempts === 2 ? 'refused_once' : 'at_court';
      if (caseView !== null && caseView.state === CaseState.Ruled) return view(key, 'keeper', 'relayRuling');
      if (caseView !== null && caseView.state === CaseState.Opened) return view(key, 'court', null);
      return view(key, 'none', null);
    }
    if (back || out || dead || expired) {
      let call: NextCall;
      if (expired || dead) call = 'expireClaim';
      else if (back) call = back === 'failed' ? 'manualExecute' : 'relayRuling';
      else call = out === 'failed' ? 'manualExecute' : 'resend';
      return view('stuck', 'anyone', call, expiry);
    }
    // Not yet received on Arbitrum: the outbound message is in flight.
    if (caseView === null || caseView.state === CaseState.None) return view('at_court', 'none', null);
    const key: StatusKey =
      caseView.state === CaseState.RefilePending || caseView.attempts === 2 ? 'refused_once' : 'at_court';
    switch (caseView.state) {
      case CaseState.Received:
        return view(key, 'keeper', 'openCase', openBy(caseView.receivedAt + p.caseDeadline, caseView));
      case CaseState.RefilePending:
        return view(key, 'anyone', 'refile', openBy(caseView.ruledAt + p.caseDeadline, caseView));
      case CaseState.Ruled:
        return view(key, 'keeper', 'relayRuling');
      case CaseState.Relayed:
        return view(key, 'none', null);
      default:
        return view(key, 'court', null);
    }
  }

  if (s === ClaimStatus.Contested) {
    const expiry = claim.preCheckedAt + p.claimTimeout;
    if (now > expiry) return view('contested', 'anyone', 'expireClaim');
    return view('contested', 'anyone', 'sendToCourt', expiry);
  }
  if (s === ClaimStatus.PreChecked) {
    const end = claim.preCheckedAt + p.contestWindow;
    if (now > end) return view('window_lapsed', 'anyone', 'closeUncontested');
    if (claim.answer === 0) return view('no_finding', 'shop', 'contest', end);
    return view('finding_made', claim.answer === 1 ? 'platform' : 'shop', 'contest', end);
  }
  if (s === ClaimStatus.Filed) {
    const expiry = claim.filedAt + p.claimTimeout;
    if (now > expiry) return view('filed', 'anyone', 'expireClaim');
    return view('filed', 'preCheckSigner', 'recordPreCheck', expiry);
  }
  throw new RangeError('deriveStatus: no claim stored');
}
