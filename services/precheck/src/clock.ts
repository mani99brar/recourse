// Time source. Everything that needs "now" takes a Clock so tests can move time by hand.

export interface Clock {
  /** Unix milliseconds. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Whole unix seconds of a clock reading. */
export function nowSeconds(clock: Clock): bigint {
  return BigInt(Math.floor(clock.now() / 1000));
}
