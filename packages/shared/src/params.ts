// Protocol parameters with their pre-lock (first deploy) and locked values. Units: seconds,
// µUSDC (6 decimals), basis points, counts, gas. Deploy scripts read the same values from
// vectors/params.json; running services read the live values from the contracts' params() views.

export interface ParamSet {
  /** s, from preCheckedAt; the contest is still open at the boundary second. */
  contestWindow: number;
  /** µUSDC escrowed by the shop at filing. */
  courtFeeUsdc: number;
  /** µUSDC. */
  handlingBase: number;
  /** bps of the basket. */
  handlingBps: number;
  /** µUSDC. */
  handlingCap: number;
  /** µUSDC; start value, to be adjusted once the faucet amounts are known. */
  minDeposit: number;
  /** s. */
  topUpWindow: number;
  /** s. */
  exitDelay: number;
  /** s between CCIP sends of one claim. */
  resendGap: number;
  /** CCIP sends per claim and leg. */
  maxSends: number;
  /** s; Arbitrum case deadline, exclusive. */
  caseDeadline: number;
  maxOpenCases: number;
  /** s; a Filed claim expires after filedAt + this, a Contested or AtCourt one after preCheckedAt + this. */
  claimTimeout: number;
  /** s an Untouched CCIP message may wait before it counts as stuck. */
  stuckAfter: number;
  /** ruled cases before the docket publishes rates. */
  publishThreshold: number;
  batchSize: number;
  /** bps inclusion probability for a batched claim. */
  pBps: number;
  gasClaimToCourt: number;
  gasRulingBack: number;
  gasCap: number;
  /** multiple of arbitrationCost below which the keeper alerts on the fee pool. */
  feePoolAlertMultiple: number;
}

const shared = {
  courtFeeUsdc: 3_000_000,
  minDeposit: 10_000_000,
  handlingBase: 15_000_000,
  handlingBps: 500,
  handlingCap: 40_000_000,
  topUpWindow: 604_800,
  resendGap: 1_800,
  maxSends: 5,
  caseDeadline: 7_200,
  maxOpenCases: 10,
  claimTimeout: 64_800,
  stuckAfter: 3_600,
  publishThreshold: 20,
  batchSize: 8,
  pBps: 2_500,
  gasClaimToCourt: 150_000,
  gasRulingBack: 150_000,
  gasCap: 3_000_000,
  feePoolAlertMultiple: 3,
} as const;

export const PARAMS: { preLock: ParamSet; locked: ParamSet } = {
  preLock: { ...shared, contestWindow: 600, exitDelay: 600 },
  locked: { ...shared, contestWindow: 1_800, exitDelay: 10_368_000 },
};

/** Handling fee: min(handlingBase + floor(basket * handlingBps / 10000), handlingCap), in µUSDC. */
export function handlingOf(
  basketUsdc: bigint,
  p: { handlingBase: bigint | number; handlingBps: bigint | number; handlingCap: bigint | number },
): bigint {
  const h = BigInt(p.handlingBase) + (basketUsdc * BigInt(p.handlingBps)) / 10_000n;
  const cap = BigInt(p.handlingCap);
  return h < cap ? h : cap;
}
