// Claim set: what the docket knows about each claim, built only from chain events. Pure functions,
// no I/O. The case row to publish and the monthly counts are both derived from this state, so
// replaying the same events always gives the same rows.

import type { Hex } from 'viem';
import type { DocketEvent } from './events.js';
import {
  CASE_TIER,
  COUNT_TIER,
  GAP_PARTITION,
  SCHEMA_VERSION,
  STATUS_PARTITION,
  countKey,
  monthOf,
  type CaseRow,
  type CountRow,
} from './schema.js';

export interface RulingInfo {
  disputeId: string;
  ruling: number;
  attempts: number;
  ts: number;
}

export interface ClaimState {
  claimId: Hex;
  /** False until ClaimFiled has been seen: such a claim is held back from rows and counts. */
  filed: boolean;
  platform: string;
  shop: string;
  filedAt: number;
  gap: number | null;
  answer: number | null;
  terminal: null | 'closedUncontested' | 'expired' | 'undrawn';
  ruling: RulingInfo | null;
  /** Dispute id from the case contract, used only when the ruling event carries none. */
  caseDisputeId: string | null;
  paid: bigint | null;
  refund: bigint | null;
  settledAt: number | null;
  shortfall: bigint | null;
  /** 10000 unless a batch left the claim a chance of being left out. */
  inclusionBps: number;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export function newClaimState(claimId: Hex): ClaimState {
  return {
    claimId,
    filed: false,
    platform: ZERO_ADDR,
    shop: ZERO_ADDR,
    filedAt: 0,
    gap: null,
    answer: null,
    terminal: null,
    ruling: null,
    caseDisputeId: null,
    paid: null,
    refund: null,
    settledAt: null,
    shortfall: null,
    inclusionBps: 10000,
  };
}

/** Applies one event. Applying the same event again changes nothing. */
export function applyEvent(claims: Map<Hex, ClaimState>, e: DocketEvent): ClaimState {
  let c = claims.get(e.claimId);
  if (c === undefined) {
    c = newClaimState(e.claimId);
    claims.set(e.claimId, c);
  }
  switch (e.name) {
    case 'ClaimFiled':
      c.filed = true;
      c.platform = e.platform;
      c.shop = e.shop;
      c.filedAt = e.filedAt;
      break;
    case 'PreCheckRecorded':
      c.gap = e.gap;
      c.answer = e.answer;
      break;
    case 'ClosedUncontested':
      c.terminal = 'closedUncontested';
      break;
    case 'ClaimExpired':
      c.terminal = 'expired';
      break;
    case 'ClosedUndrawn':
      c.terminal = 'undrawn';
      break;
    case 'RulingReceived':
      // A later final ruling replaces an earlier one only if it carries more attempts.
      if (c.ruling === null || e.attempts >= c.ruling.attempts) {
        c.ruling = { disputeId: e.disputeId, ruling: e.ruling, attempts: e.attempts, ts: e.ts };
      }
      break;
    case 'Settled':
      c.settledAt = e.ts;
      break;
    case 'OutcomeApplied':
      c.paid = BigInt(e.paid);
      c.refund = BigInt(e.refund);
      if (c.settledAt === null) c.settledAt = e.ts;
      break;
    case 'Shortfall':
      c.shortfall = BigInt(e.amount);
      break;
    case 'CaseOpened':
      c.caseDisputeId = e.disputeId;
      break;
  }
  return c;
}

/** The ruling to publish: 1-3, or a second refusal. A first refusal is refiled, not published. */
export function isCaseDue(c: ClaimState): boolean {
  if (!c.filed || c.ruling === null) return false;
  const { ruling, attempts } = c.ruling;
  return (ruling >= 1 && ruling <= 3) || (ruling === 0 && attempts >= 2);
}

/** What rates count: the ruling, else the pre-check answer after two refusals, else 0. */
export function outcomeOf(c: ClaimState): number {
  if (c.ruling === null) return 0;
  const { ruling, attempts } = c.ruling;
  if (ruling >= 1 && ruling <= 3) return ruling;
  if (ruling === 0 && attempts >= 2 && c.answer !== null && c.answer >= 1 && c.answer <= 3) return c.answer;
  return 0;
}

export function caseRowOf(c: ClaimState, reasonCid = ''): CaseRow {
  if (!isCaseDue(c) || c.ruling === null) throw new Error('caseRowOf: no ruling to publish');
  const outcome = outcomeOf(c);
  const credited = c.paid === null ? 0n : c.paid + (c.refund ?? 0n);
  return {
    claimId: c.claimId,
    platform: c.platform as CaseRow['platform'],
    shop: c.shop as CaseRow['shop'],
    gap: c.gap ?? 0,
    answer: c.answer ?? 0,
    ruling: c.ruling.ruling,
    outcome,
    unresolved: outcome === 0,
    zeroTwice: c.ruling.ruling === 0,
    tier: CASE_TIER,
    month: monthOf(c.filedAt),
    attempts: c.ruling.attempts,
    disputeId: c.ruling.disputeId !== '0' ? c.ruling.disputeId : (c.caseDisputeId ?? '0'),
    inclusionBps: c.inclusionBps,
    toShopUsdc: credited.toString(),
    settledAt: c.settledAt ?? 0,
    reasonCid,
    v: SCHEMA_VERSION,
  };
}

export type StatusBucket = (typeof STATUS_PARTITION)[number];
export type GapBucket = (typeof GAP_PARTITION)[number];

/** The one status bucket a filed claim sits in. `written` is whether its case entity is written. */
export function statusBucket(c: ClaimState, written: boolean): StatusBucket {
  if (c.terminal === 'closedUncontested') return 'closedUncontested';
  if (c.terminal === 'expired') return 'expired';
  if (c.terminal === 'undrawn') return 'undrawn';
  if (isCaseDue(c)) {
    if (!written) return 'ruledNotWritten';
    return outcomeOf(c) === 0 ? 'unresolved' : 'ruled';
  }
  return 'open';
}

/** The one gap bucket a filed claim sits in. */
export function gapBucket(c: ClaimState): GapBucket {
  if (c.gap === null || c.answer === null) return 'notPreChecked';
  if (c.gap === 1) return 'gap1';
  if (c.gap === 2) return 'gap2';
  if (c.gap === 3) return 'gap3';
  if (c.gap === 0) return 'noGap';
  // gap 255: no gap code
  return c.answer === 1 || c.answer === 2 ? 'missingRecord' : 'notEnough';
}

export function emptyCount(month: string, platform: string, shop: string): CountRow {
  return {
    month,
    platform: platform as CountRow['platform'],
    shop: shop as CountRow['shop'],
    tier: COUNT_TIER,
    filed: 0, gap1: 0, gap2: 0, gap3: 0, noGap: 0, notEnough: 0, missingRecord: 0, notPreChecked: 0,
    ruled: 0, unresolved: 0, closedUncontested: 0, open: 0, ruledNotWritten: 0, expired: 0, undrawn: 0,
    v: SCHEMA_VERSION,
  };
}

/** One count row per (month, platform, shop) over every filed claim. No totals are stored. */
export function countsOf(claims: Iterable<ClaimState>, isWritten: (claimId: Hex) => boolean): Map<string, CountRow> {
  const rows = new Map<string, CountRow>();
  for (const c of claims) {
    if (!c.filed) continue;
    const month = monthOf(c.filedAt);
    const key = countKey({ month, platform: c.platform as CountRow['platform'], shop: c.shop as CountRow['shop'] });
    let row = rows.get(key);
    if (row === undefined) {
      row = emptyCount(month, c.platform, c.shop);
      rows.set(key, row);
    }
    row.filed += 1;
    row[statusBucket(c, isWritten(c.claimId))] += 1;
    row[gapBucket(c)] += 1;
  }
  return rows;
}
