// Spend limits, in micro-USDC. Within the spend limit the agent approves on its mandate; above it,
// up to the per-order maximum, a buyer must sign; above the maximum, or past the daily cap (UTC
// day), the order is refused before any record is written.

type Env = Record<string, string | undefined>;

export interface Limits {
  spendLimit: bigint;
  maxOrder: bigint;
  dailyCap: bigint;
  approvalTtlSec: number;
}

export const DEFAULT_LIMITS: Limits = {
  spendLimit: 5_000_000n,
  maxOrder: 25_000_000n,
  dailyCap: 50_000_000n,
  approvalTtlSec: 600,
};

function micro(env: Env, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${name}: expected micro-USDC as a whole number`);
  return BigInt(raw);
}

export function readLimits(env: Env = process.env): Limits {
  const ttl = env.AGENT_APPROVAL_TTL_SEC ? Number(env.AGENT_APPROVAL_TTL_SEC) : DEFAULT_LIMITS.approvalTtlSec;
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('AGENT_APPROVAL_TTL_SEC: expected whole seconds');
  const limits = {
    spendLimit: micro(env, 'AGENT_SPEND_LIMIT_USDC', DEFAULT_LIMITS.spendLimit),
    maxOrder: micro(env, 'AGENT_MAX_ORDER_USDC', DEFAULT_LIMITS.maxOrder),
    dailyCap: micro(env, 'AGENT_DAILY_CAP_USDC', DEFAULT_LIMITS.dailyCap),
    approvalTtlSec: ttl,
  };
  if (limits.spendLimit > limits.maxOrder) throw new Error('AGENT_SPEND_LIMIT_USDC is above AGENT_MAX_ORDER_USDC');
  return limits;
}

export type LimitDecision =
  | { kind: 'mandate' }
  | { kind: 'buyer' }
  | { kind: 'refused'; reason: 'above_max_order' | 'daily_cap' };

/** `spentToday` counts every order of the UTC day that is paid or may still be paid. */
export function decideLimit(amount: bigint, spentToday: bigint, limits: Limits): LimitDecision {
  if (amount > limits.maxOrder) return { kind: 'refused', reason: 'above_max_order' };
  if (spentToday + amount > limits.dailyCap) return { kind: 'refused', reason: 'daily_cap' };
  return amount <= limits.spendLimit ? { kind: 'mandate' } : { kind: 'buyer' };
}

/** `YYYY-MM-DD` of a Unix time in UTC. */
export function utcDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
