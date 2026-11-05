// Settle mirror: the same money split the Hedera contracts apply, for services and pages that
// need to show or check it. Pure integer µUSDC with floor division.

import type { Answer, Gap } from './codes.js';
import { handlingOf } from './params.js';

export type SettlePath = 'uncontested' | 'ruled' | 'expired' | 'undrawn';

export const SETTLE_ROWS = [
  'uncontested_platform',
  'uncontested_other',
  'ruled_platform',
  'ruled_shop',
  'ruled_neither_flagged',
  'ruled_neither_other',
  'zero_twice_answer',
  'zero_twice_unresolved',
  'expired',
  'undrawn',
  'not_settleable',
] as const;
export type SettleRow = (typeof SETTLE_ROWS)[number];

/** Who the escrowed court fee counts against. */
export type FeeOn = 'platform' | 'shop' | 'split' | 'none';

export interface SettleInput {
  /** How the claim ends: closed uncontested, settled after a ruling, expired, or closed undrawn. */
  outcome: SettlePath;
  /** Ruling received (ruled path only). */
  ruling?: number;
  /** Court attempts reported with the ruling (ruled path only). */
  attempts?: number;
  /** Stored pre-check gap and answer. */
  gap: Gap;
  answer: Answer;
  basketUsdc: bigint;
  netLossUsdc: bigint;
  /** The fee escrowed for this claim at filing (not the current courtFeeUsdc). */
  feeUsdc: bigint;
  params: { handlingBase: bigint | number; handlingBps: bigint | number; handlingCap: bigint | number };
}

export interface SettleResult {
  row: SettleRow;
  /** Owed to the shop from the platform's deposit (before any deposit cap); `applyOutcome` argument. */
  toShop: bigint;
  /** Escrowed fee returned to the shop; `applyOutcome` argument. */
  refundToShop: bigint;
  /** Escrowed fee kept by the pool: feeUsdc - refundToShop. */
  toPool: bigint;
  feeOn: FeeOn;
  /** Handling included in toShop (0 when none). */
  handling: bigint;
  unresolved: boolean;
  /** The answer the money follows; null for expired, undrawn and not settleable. */
  appliedAnswer: Answer | null;
  /** Code emitted as `Settled.outcome` on the ruled path; null otherwise. */
  settledOutcome: number | null;
}

function result(
  row: SettleRow,
  i: SettleInput,
  toShop: bigint,
  refund: bigint,
  feeOn: FeeOn,
  handling: bigint,
  appliedAnswer: Answer | null,
  settledOutcome: number | null,
  unresolved = false,
): SettleResult {
  return { row, toShop, refundToShop: refund, toPool: i.feeUsdc - refund, feeOn, handling, unresolved, appliedAnswer, settledOutcome };
}

function ruledAs(i: SettleInput, answer: 1 | 2 | 3, row: SettleRow | undefined, code: number): SettleResult {
  const F = i.feeUsdc;
  if (answer === 1) {
    const H = handlingOf(i.basketUsdc, i.params);
    return result(row ?? 'ruled_platform', i, i.netLossUsdc + H + F, 0n, 'platform', H, 1, code);
  }
  if (answer === 2) return result(row ?? 'ruled_shop', i, 0n, 0n, 'shop', 0n, 2, code);
  if (i.gap === 1 || i.gap === 2) return result(row ?? 'ruled_neither_flagged', i, F, 0n, 'platform', 0n, 3, code);
  return result(row ?? 'ruled_neither_other', i, 0n, 0n, 'shop', 0n, 3, code);
}

/** The split for one claim. */
export function settleOutcome(i: SettleInput): SettleResult {
  const F = i.feeUsdc;
  switch (i.outcome) {
    case 'expired':
      return result('expired', i, 0n, F, 'none', 0n, null, null);
    case 'undrawn':
      return result('undrawn', i, 0n, F, 'none', 0n, null, null);
    case 'uncontested':
      if (i.answer === 1) {
        const H = handlingOf(i.basketUsdc, i.params);
        return result('uncontested_platform', i, i.netLossUsdc + H, F, 'none', H, 1, null);
      }
      return result('uncontested_other', i, 0n, F, 'none', 0n, i.answer, null);
    case 'ruled': {
      const r = i.ruling;
      if (r === 1 || r === 2 || r === 3) return ruledAs(i, r, undefined, r);
      if (r === 0 && i.attempts === 2) {
        if (i.answer === 0) return result('zero_twice_unresolved', i, F / 2n, 0n, 'split', 0n, 0, 0, true);
        return ruledAs(i, i.answer, 'zero_twice_answer', i.answer);
      }
      return { row: 'not_settleable', toShop: 0n, refundToShop: 0n, toPool: 0n, feeOn: 'none', handling: 0n, unresolved: false, appliedAnswer: null, settledOutcome: null };
    }
  }
}

/** What a deposit can pay of an amount owed. The mirror never caps by deposit itself. */
export function drawFromDeposit(owed: bigint, held: bigint): { paid: bigint; notCovered: bigint } {
  const paid = owed < held ? owed : held;
  return { paid, notCovered: owed - paid };
}
