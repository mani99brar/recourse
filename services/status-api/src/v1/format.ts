// Amounts as the previews show them: base units as a decimal string, plus a display text.

import type { Address } from 'viem';

export type Movement = 'escrow' | 'reserve' | 'credit' | 'receive' | 'send' | 'contract_pays' | 'info';

export interface Amount {
  name: string;
  amount: bigint;
  decimals: number;
  symbol: string;
  display: string;
  movement: Movement;
  account: Address | null;
}

export interface Unit {
  decimals: number;
  symbol: string;
}

/** HBAR as the Hedera EVM counts it inside contracts (tinybar), e.g. a CCIP fee paid in HBAR. */
export const TINYBAR: Unit = { decimals: 8, symbol: 'HBAR' };
export const LINK: Unit = { decimals: 18, symbol: 'LINK' };
export const ETH: Unit = { decimals: 18, symbol: 'ETH' };

function split(amount: bigint, decimals: number): { whole: string; frac: string } {
  const s = amount.toString().padStart(decimals + 1, '0');
  return { whole: s.slice(0, s.length - decimals) || '0', frac: decimals > 0 ? s.slice(s.length - decimals) : '' };
}

/** A token amount: at least two decimals, more only when they are not zero ("25.00", "1.234567"). */
export function tokenText(amount: bigint, u: Unit): string {
  const { whole, frac } = split(amount, u.decimals);
  const trimmed = frac.replace(/0+$/, '');
  const shown = trimmed.length >= 2 ? trimmed : frac.slice(0, 2).padEnd(2, '0');
  return `${whole}${u.decimals > 0 ? `.${shown}` : ''} ${u.symbol}`;
}

/** A fee: two decimals from 0.01 up, else two significant digits ("0.36 HBAR", "0.000021 ETH"). */
export function feeText(amount: bigint, u: Unit): string {
  if (amount === 0n) return `0 ${u.symbol}`;
  const unit = 10n ** BigInt(u.decimals);
  const cent = unit / 100n;
  if (cent > 0n && amount >= cent) {
    const rounded = ((amount + cent / 2n) / cent) * cent;
    const { whole, frac } = split(rounded, u.decimals);
    return `${whole}.${frac.slice(0, 2)} ${u.symbol}`;
  }
  const digits = amount.toString().length;
  const keep = 2;
  const drop = BigInt(Math.max(0, digits - keep));
  const step = 10n ** drop;
  const rounded = ((amount + step / 2n) / step) * step;
  const { whole, frac } = split(rounded, u.decimals);
  return `${whole}.${frac.replace(/0+$/, '') || '0'} ${u.symbol}`;
}

export function amountOf(name: string, amount: bigint, u: Unit, movement: Movement, account: Address | null): Amount {
  return { name, amount, decimals: u.decimals, symbol: u.symbol, display: tokenText(amount, u), movement, account };
}
