// TEST ONLY: row builders.

import type { CaseRow, CountRow } from '../src/schema.js';

export const PLATFORM = '0xff845c7d57eb58f30dEEE83a96010FeE055FdaF6' as const;
export const SHOP = '0x0d87ED2F5D792561B53043Ff028956125c820287' as const;

export function caseRow(n: number, over: Partial<CaseRow> = {}): CaseRow {
  return {
    claimId: `0x${n.toString(16).padStart(64, '0')}`,
    platform: PLATFORM,
    shop: SHOP,
    gap: 2,
    answer: 1,
    ruling: 1,
    outcome: 1,
    unresolved: false,
    zeroTwice: false,
    tier: 'ruled',
    month: '2026-11',
    attempts: 1,
    disputeId: '17',
    inclusionBps: 10000,
    toShopUsdc: '0',
    settledAt: 0,
    reasonCid: '',
    v: 1,
    ...over,
  };
}

export function countRow(over: Partial<CountRow> = {}): CountRow {
  return {
    month: '2026-11', platform: PLATFORM, shop: SHOP, tier: 'reported',
    filed: 3, gap1: 0, gap2: 2, gap3: 0, noGap: 1, notEnough: 0, missingRecord: 0, notPreChecked: 0,
    ruled: 2, unresolved: 0, closedUncontested: 1, open: 0, ruledNotWritten: 0, expired: 0, undrawn: 0, v: 1, ...over,
  };
}

