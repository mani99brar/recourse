// Hedera consensus timestamps as the mirror node writes them: "<seconds>.<9-digit nanos>".

const TS = /^(\d+)(?:\.(\d{1,9}))?$/;

export interface Ts {
  s: bigint;
  ns: bigint;
}

export function parseTs(text: string): Ts {
  const m = TS.exec(text);
  if (!m) throw new RangeError(`bad consensus timestamp ${text}`);
  return { s: BigInt(m[1]!), ns: BigInt((m[2] ?? '').padEnd(9, '0') || '0') };
}

export function formatTs(t: Ts): string {
  return `${t.s}.${t.ns.toString().padStart(9, '0')}`;
}

/** -1, 0 or 1. */
export function compareTs(a: string, b: string): -1 | 0 | 1 {
  const x = parseTs(a);
  const y = parseTs(b);
  if (x.s !== y.s) return x.s < y.s ? -1 : 1;
  if (x.ns !== y.ns) return x.ns < y.ns ? -1 : 1;
  return 0;
}

/** Whole seconds, truncated. */
export function tsSeconds(text: string): bigint {
  return parseTs(text).s;
}

/** The timestamp moved back by `seconds` (never below zero). */
export function tsMinusSeconds(text: string, seconds: number): string {
  const t = parseTs(text);
  const s = t.s - BigInt(seconds);
  return formatTs(s < 0n ? { s: 0n, ns: 0n } : { s, ns: t.ns });
}

/** A timestamp for a Unix second. */
export function tsOfSeconds(seconds: bigint | number): string {
  return formatTs({ s: BigInt(seconds), ns: 0n });
}
