import type { VaultToken } from '@recourse/shared';

/**
 * A vault amount in micro-units (decimal text or bigint) with the deployment's token label:
 * "12.50 USDC", or "12.50 mUSDC (testnet mock)" on the testnet mock. USDC when no token is known.
 */
export function usdc(v: string | bigint | null | undefined, token?: Pick<VaultToken, 'label'> | null): string {
  if (v === null || v === undefined) return 'not yet known';
  const n = BigInt(v);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').slice(0, 2);
  return `${whole.toLocaleString('en-US')}.${frac} ${token?.label ?? 'USDC'}`;
}

/** The note a page carries when the vault runs on the testnet mock; null on Circle USDC. */
export function mockNote(token: Pick<VaultToken, 'mode'> | null | undefined): string | null {
  return token?.mode === 'mock'
    ? "This deployment's vault runs on mUSDC, a testnet mock of USDC: it is not Circle's USDC and is worth nothing. Circle's testnet faucet did not deliver."
    : null;
}

export function when(sec: string | number | bigint | null | undefined): string {
  if (sec === null || sec === undefined) return 'not set';
  const d = new Date(Number(sec) * 1000);
  return d.toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
}

export function short(hex: string, n = 6): string {
  return hex.length > 2 * n + 3 ? `${hex.slice(0, n + 2)}…${hex.slice(-n)}` : hex;
}

/** µUSDC text from a decimal amount typed by a person ("12.5"); null when it is not a plain amount. */
export function parseUsdc(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** Like `when`, with seconds (for event lists where many events share a minute). */
export function whenS(sec: string | number | bigint | null | undefined): string {
  if (sec === null || sec === undefined) return 'not set';
  return new Date(Number(sec) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
