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

/** True when the Arbitrum case can no longer move: Stale, or its open/refile window has closed. */
function caseDead(c: CaseView | null, p: LiveParams, now: bigint): boolean {
  if (c === null) return false;
  if (c.state === CaseState.Stale) return true;
  if (c.state === CaseState.Received && now >= c.receivedAt + p.caseDeadline) return true;
  if (c.state === CaseState.RefilePending && now >= c.ruledAt + p.caseDeadline) return true;
  return false;
}

/** Status of one claim. First matching row wins. */
export function deriveStatus(
  claim: ClaimForStatus,
  caseView: CaseView | null,
  bridgeViews: readonly BridgeView[],
  p: LiveParams,
  now: bigint,
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
    const expiry = claim.filedAt + p.claimTimeout;
    const back = legStuck(latest(bridgeViews, 'toHedera'), p, now);
    const out = legStuck(latest(bridgeViews, 'toArbitrum'), p, now);
    const dead = caseDead(caseView, p, now);
    if (back || out || dead) {
      let call: NextCall;
      if (now > expiry || dead) call = 'expireClaim';
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
        return view(key, 'keeper', 'openCase', caseView.receivedAt + p.caseDeadline);
      case CaseState.RefilePending:
        return view(key, 'anyone', 'refile', caseView.ruledAt + p.caseDeadline);
      case CaseState.Ruled:
        return view(key, 'keeper', 'relayRuling');
      case CaseState.Relayed:
        return view(key, 'none', null);
      default:
        return view(key, 'court', null);
    }
  }

  if (s === ClaimStatus.Contested) return view('contested', 'anyone', 'sendToCourt');
  if (s === ClaimStatus.PreChecked) {
    const end = claim.preCheckedAt + p.contestWindow;
    if (now > end) return view('window_lapsed', 'anyone', 'closeUncontested');
    if (claim.answer === 0) return view('no_finding', 'shop', 'contest', end);
    return view('finding_made', claim.answer === 1 ? 'platform' : 'shop', 'contest', end);
  }
  if (s === ClaimStatus.Filed) return view('filed', 'preCheckSigner', 'recordPreCheck');
  throw new RangeError('deriveStatus: no claim stored');
}
