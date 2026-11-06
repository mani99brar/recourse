// Pure joins: fold one claim's events into a claim record, build the views the shared status
// derivation needs, and compute the money lines. Nothing here reads a network.

import {
  CaseState,
  ClaimStatus,
  ExecutionState,
  settleOutcome,
  type Answer,
  type BridgeView,
  type CaseView,
  type Gap,
  type LiveParams,
  type Ruling,
  type SettleResult,
} from '@recourse/shared';
import type { Address, Hex } from 'viem';
import type { KlerosRead, LiveState, RawCaseView } from './store.js';
import type { IndexedEvent } from './types.js';

const ZERO32 = '0x' + '00'.repeat(32);

export interface MessageRef {
  messageId: Hex;
  sendNo: number;
  time: bigint;
  tx: Hex;
}

export interface FoldedClaim {
  claimId: Hex;
  orderId: Hex;
  shop: Address;
  platform: Address;
  refs: { topicNum: bigint; seq: readonly bigint[]; hashes: readonly Hex[] };
  basketUsdc: bigint;
  netLossUsdc: bigint;
  filedAt: bigint;
  preCheckedAt: bigint;
  gap: Gap;
  answer: Answer;
  packHash: Hex;
  contestedBy: Address | null;
  contestedAt: bigint | null;
  sendCount: number;
  lastSendAt: bigint;
  lastMessageId: Hex;
  disputeId: bigint;
  ruling: Ruling;
  attempts: number;
  status: ClaimStatus;
  /** FeeEscrowed.amount. */
  fee: bigint | null;
  closed: { toShop: bigint; answer: number } | null;
  settled: { outcome: number; toShop: bigint; toPool: bigint } | null;
  applied: { paid: bigint; refund: bigint; toPool: bigint } | null;
  shortfall: bigint | null;
  toCourt: MessageRef[];
  relayed: MessageRef[];
  disputeIds: bigint[];
  preChecked: boolean;
  updatedAt: bigint;
}

/** Folds a claim's events (already in time order) into its current record. Null before ClaimFiled. */
export function foldClaim(events: readonly IndexedEvent[]): FoldedClaim | null {
  let c: FoldedClaim | null = null;
  for (const e of events) {
    const a = e.args;
    if (e.name === 'ClaimFiled' && c === null) {
      const refs = a.refs as { topicNum: bigint; seq: readonly bigint[]; hashes: readonly Hex[] };
      c = {
        claimId: a.claimId as Hex,
        orderId: a.orderId as Hex,
        shop: a.shop as Address,
        platform: a.platform as Address,
        refs,
        basketUsdc: a.basketUsdc as bigint,
        netLossUsdc: a.netLossUsdc as bigint,
        filedAt: a.filedAt as bigint,
        preCheckedAt: 0n,
        gap: 0,
        answer: 0,
        packHash: ZERO32 as Hex,
        contestedBy: null,
        contestedAt: null,
        sendCount: 0,
        lastSendAt: 0n,
        lastMessageId: ZERO32 as Hex,
        disputeId: 0n,
        ruling: 0,
        attempts: 0,
        status: ClaimStatus.Filed,
        fee: null,
        closed: null,
        settled: null,
        applied: null,
        shortfall: null,
        toCourt: [],
        relayed: [],
        disputeIds: [],
        preChecked: false,
        updatedAt: e.time,
      };
      continue;
    }
    if (c === null) continue;
    if (e.time > c.updatedAt) c.updatedAt = e.time;
    switch (e.name) {
      case 'PreCheckRecorded':
        c.gap = Number(a.gap) as Gap;
        c.answer = Number(a.answer) as Answer;
        c.packHash = a.packHash as Hex;
        c.preCheckedAt = e.time;
        c.preChecked = true;
        c.status = ClaimStatus.PreChecked;
        break;
      case 'Contested':
        c.contestedBy = a.by as Address;
        c.contestedAt = e.time;
        c.status = ClaimStatus.Contested;
        break;
      case 'ClosedUncontested':
        c.closed = { toShop: a.toShop as bigint, answer: Number(a.answer) };
        c.status = ClaimStatus.Closed;
        break;
      case 'SentToCourt': {
        c.sendCount += 1;
        c.lastSendAt = e.time;
        c.lastMessageId = a.messageId as Hex;
        c.toCourt.push({ messageId: a.messageId as Hex, sendNo: c.toCourt.length + 1, time: e.time, tx: e.tx });
        if (c.status === ClaimStatus.Contested || c.status === ClaimStatus.PreChecked) c.status = ClaimStatus.AtCourt;
        break;
      }
      case 'RulingReceived':
        c.disputeId = a.disputeId as bigint;
        c.ruling = Number(a.ruling) as Ruling;
        c.attempts = Number(a.attempts);
        c.status = ClaimStatus.Ruled;
        break;
      case 'Settled':
        c.settled = { outcome: Number(a.outcome), toShop: a.toShop as bigint, toPool: a.toPool as bigint };
        c.status = ClaimStatus.Settled;
        break;
      case 'ClaimExpired':
        c.status = ClaimStatus.Expired;
        break;
      case 'FeeEscrowed':
        c.fee = a.amount as bigint;
        break;
      case 'OutcomeApplied':
        c.applied = { paid: a.paid as bigint, refund: a.refund as bigint, toPool: a.toPool as bigint };
        break;
      case 'Shortfall':
        c.shortfall = (c.shortfall ?? 0n) + (a.amount as bigint);
        break;
      case 'CaseOpened': {
        const d = a.disputeId as bigint;
        if (!c.disputeIds.includes(d)) c.disputeIds.push(d);
        break;
      }
      case 'RulingRelayed': {
        const id = a.messageId as Hex;
        c.relayed.push({ messageId: id, sendNo: c.relayed.length + 1, time: e.time, tx: e.tx });
        break;
      }
      default:
        break;
    }
  }
  // A claim filed after its own FeeEscrowed (same tx, vault event first) still gets its fee.
  if (c !== null && c.fee === null) {
    const fe = events.find((e) => e.name === 'FeeEscrowed');
    if (fe) c.fee = fe.args.amount as bigint;
  }
  return c;
}

/**
 * The Arbitrum case as the status derivation sees it: the live read, else rebuilt from the case
 * events. The events win when they are further along (a later attempt, or a later state in the
 * same attempt), as after a ruling whose case read failed: the read kept is from before it.
 */
export function caseViewOf(claim: FoldedClaim, events: readonly IndexedEvent[], live: LiveState | undefined): CaseView | null {
  const read = live?.caseView ? readCaseView(live.caseView) : null;
  const rebuilt = eventCaseView(events);
  let v = read ?? rebuilt;
  if (read && rebuilt && (rebuilt.attempts > read.attempts || (rebuilt.attempts === read.attempts && rebuilt.state > read.state))) {
    // What the events do not carry stays from the read: the payload hash (fixed at receipt) and
    // the templates and dispute ids of the attempts it saw. Its expiry was for an earlier state.
    v = { ...rebuilt, payloadHash: read.payloadHash, templateIds: read.templateIds, disputeIds: [rebuilt.disputeIds[0] || read.disputeIds[0], rebuilt.disputeIds[1] || read.disputeIds[1]] };
  }
  if (!v) return null;
  void claim;
  const current = v.attempts >= 2 ? v.disputeIds[1] : v.disputeIds[0];
  const kl: KlerosRead | undefined = live?.kleros[current.toString()];
  if (kl) {
    if (kl.period !== null) v.period = kl.period;
    v.currentRuling = kl.currentRuling;
    v.tied = kl.tied;
    v.overridden = kl.overridden;
  }
  return v;
}

function readCaseView(c: RawCaseView): CaseView {
  const v: CaseView = {
    state: c.state as CaseState,
    payloadHash: c.payloadHash,
    receivedAt: c.receivedAt,
    attempts: c.attempts,
    disputeIds: c.disputeIds,
    templateIds: c.templateIds,
    ruling: c.ruling,
    ruledAt: c.ruledAt,
    sendCount: c.sendCount,
    lastSendAt: c.lastSendAt,
    lastMessageId: c.lastMessageId,
  };
  if (c.expiresAt !== undefined && c.expiresAt > 0n) v.expiresAt = c.expiresAt;
  return v;
}

/** The case rebuilt from its indexed events; null before ClaimReceived. */
function eventCaseView(events: readonly IndexedEvent[]): CaseView | null {
  let state: CaseState = CaseState.None;
  let receivedAt = 0n;
  let attempts = 0;
  const disputeIds: [bigint, bigint] = [0n, 0n];
  let ruling = 0;
  let ruledAt = 0n;
  let sendCount = 0;
  let lastSendAt = 0n;
  let lastMessageId: Hex = ZERO32 as Hex;
  for (const e of events) {
    if (e.contract !== 'case') continue;
    const a = e.args;
    if (e.name === 'ClaimReceived' && state === CaseState.None) {
      state = CaseState.Received;
      receivedAt = e.time;
    } else if (e.name === 'CaseOpened') {
      const n = Number(a.attempt);
      attempts = n;
      if (n === 1 || n === 2) disputeIds[n - 1] = a.disputeId as bigint;
      state = CaseState.Opened;
    } else if (e.name === 'RefileNeeded') {
      state = CaseState.RefilePending;
      ruledAt = e.time;
    } else if (e.name === 'RulingFinal') {
      state = CaseState.Ruled;
      ruling = Number(a.ruling);
      ruledAt = e.time;
    } else if (e.name === 'RulingRelayed') {
      state = CaseState.Relayed;
      sendCount += 1;
      lastSendAt = e.time;
      lastMessageId = a.messageId as Hex;
    } else if (e.name === 'ClaimStale') {
      state = CaseState.Stale;
    }
  }
  if (state === CaseState.None) return null;
  return {
    state,
    payloadHash: ZERO32 as Hex,
    receivedAt,
    attempts,
    disputeIds,
    templateIds: [0n, 0n],
    ruling,
    ruledAt,
    sendCount,
    lastSendAt,
    lastMessageId,
  };
}

/**
 * One bridge view per known CCIP message whose destination state has been read. A direction whose
 * newest message is not read yet gets none: the status takes the newest send of a direction, so
 * an older failed or untouched leg would otherwise call a claim stuck right after its resend.
 */
export function bridgeViewsOf(claim: FoldedClaim, live: LiveState | undefined): BridgeView[] {
  const out: BridgeView[] = [];
  const add = (refs: readonly MessageRef[], direction: BridgeView['direction']) => {
    const sent = refs.filter((m) => m.messageId !== ZERO32); // ZERO32: sent without CCIP
    const newest = sent[sent.length - 1];
    if (newest === undefined || live?.exec[newest.messageId] === undefined) return;
    for (const m of sent) {
      const st = live.exec[m.messageId];
      if (st === undefined) continue;
      out.push({ messageId: m.messageId, direction, sendNo: m.sendNo, executionState: st as ExecutionState, sentAt: m.time });
    }
  };
  add(claim.toCourt, 'toArbitrum');
  add(claim.relayed, 'toHedera');
  return out;
}

export function isTerminal(status: ClaimStatus): boolean {
  return status === ClaimStatus.Settled || status === ClaimStatus.Closed || status === ClaimStatus.Expired;
}

export type EscrowFate = 'held' | 'refunded' | 'kept_by_pool' | 'split' | 'none';

export interface Money {
  owed: bigint | null;
  paid: bigint | null;
  credited: bigint | null;
  notCovered: bigint | null;
  escrow: { amount: bigint; fate: EscrowFate };
  /** Which settle row the projection used; null when none applies yet. */
  row: string | null;
  projected: boolean;
}

export interface MoneyParams {
  handlingBase: bigint;
  handlingBps: bigint;
  handlingCap: bigint;
  courtFeeUsdc: bigint;
  contestWindow: bigint;
}

/**
 * The five money lines of a claim. `owed` is the amount the contracts apply once the claim is
 * decided: exact after Closed or Settled, the settle mirror's projection after a ruling or a
 * lapsed window, null before. `paid`, `credited` and `notCovered` are null until the vault has
 * applied the outcome. After Settled, owed = paid + notCovered.
 */
export function moneyOf(c: FoldedClaim, p: MoneyParams, now: bigint): Money {
  const fee = c.fee ?? p.courtFeeUsdc;
  let owed: bigint | null = null;
  let row: string | null = null;
  let projected = false;
  const mirror = (path: 'uncontested' | 'ruled' | 'expired'): SettleResult =>
    settleOutcome({
      outcome: path,
      ruling: c.ruling,
      attempts: c.attempts,
      gap: c.gap,
      answer: c.answer,
      basketUsdc: c.basketUsdc,
      netLossUsdc: c.netLossUsdc,
      feeUsdc: fee,
      params: p,
    });
  if (c.settled) {
    owed = c.settled.toShop;
    row = c.status === ClaimStatus.Settled ? mirror('ruled').row : null;
  } else if (c.closed) {
    owed = c.closed.toShop;
    row = mirror('uncontested').row;
  } else if (c.status === ClaimStatus.Expired) {
    owed = 0n;
    row = 'expired';
  } else if (c.status === ClaimStatus.Ruled) {
    const r = mirror('ruled');
    if (r.row !== 'not_settleable') {
      owed = r.toShop;
      row = r.row;
      projected = true;
    }
  } else if (c.status === ClaimStatus.PreChecked && now > c.preCheckedAt + p.contestWindow) {
    const r = mirror('uncontested');
    owed = r.toShop;
    row = r.row;
    projected = true;
  }
  const paid = c.applied ? c.applied.paid : null;
  const credited = c.applied ? c.applied.paid + c.applied.refund : null;
  let notCovered: bigint | null = null;
  if (c.applied) notCovered = c.shortfall ?? 0n;
  // The fee the vault took (FeeEscrowed): with none indexed, nothing is shown as held. The
  // projection above still uses the current court fee then.
  return { owed, paid, credited, notCovered, escrow: { amount: c.fee ?? 0n, fate: escrowFate(c, fee) }, row, projected };
}

function escrowFate(c: FoldedClaim, fee: bigint): EscrowFate {
  if (c.fee === null) return 'none';
  if (!c.applied) return 'held';
  const { refund, toPool } = c.applied;
  if (refund === fee) return 'refunded';
  if (toPool === fee) return 'kept_by_pool';
  if (refund > 0n && toPool > 0n) return 'split';
  return 'kept_by_pool';
}

export function liveParamsOf(
  claims: { contestWindow: bigint; claimTimeout: bigint; resendGap: bigint; maxSends: number },
  kase: { caseDeadline: bigint; maxOpenCases: number },
  stuckAfter: bigint,
): LiveParams {
  return {
    contestWindow: claims.contestWindow,
    claimTimeout: claims.claimTimeout,
    resendGap: claims.resendGap,
    maxSends: claims.maxSends,
    caseDeadline: kase.caseDeadline,
    maxOpenCases: kase.maxOpenCases,
    stuckAfter,
  };
}
