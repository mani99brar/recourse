// The asset x402 orders are priced and paid in, chosen by PRICE_ASSET. List prices and the agent's
// spend limits are micro-USDC; in HBAR mode the shop asks for tinybar at a fixed rate, and the agent
// compares the micro-USDC equivalent with its limits. The vault's money is the deployment's own
// token, never the price asset (vaultToken.ts).

import { addressBook } from './addresses.js';

/** x402 asset id of HBAR on Hedera; amounts are tinybar (8 decimals). */
export const HBAR_ASSET_ID = '0.0.0';

/** Fixed demo rate for HBAR prices: 1 µUSDC = 100 tinybar, so 1 USDC of list price = 1 HBAR. */
export const TINYBAR_PER_MICRO_USDC = 100n;

export type PriceAsset = 'usdc' | 'hbar';

/** PRICE_ASSET, `usdc` (the default) or `hbar` in any case. Throws for anything else. */
export function priceAssetOf(env: Record<string, string | undefined>): PriceAsset {
  const value = (env.PRICE_ASSET || 'usdc').toLowerCase();
  if (value !== 'usdc' && value !== 'hbar') throw new Error('PRICE_ASSET: expected usdc or hbar');
  return value;
}

/** The x402 asset id for a price asset: USDC `0.0.429274` or HBAR `0.0.0`. */
export function priceAssetIdOf(asset: PriceAsset): string {
  return asset === 'hbar' ? HBAR_ASSET_ID : addressBook.hedera.usdc.tokenId;
}

/**
 * An x402 amount as micro-USDC: unchanged for USDC, tinybar divided by the rate for HBAR (rounded
 * up, so a remainder never slips under a limit). Throws for any other asset.
 */
export function toMicroUsdcEquivalent(amount: bigint, asset: string): bigint {
  if (amount < 0n) throw new RangeError(`toMicroUsdcEquivalent: negative amount ${amount}`);
  if (asset === addressBook.hedera.usdc.tokenId) return amount;
  if (asset === HBAR_ASSET_ID) return (amount + TINYBAR_PER_MICRO_USDC - 1n) / TINYBAR_PER_MICRO_USDC;
  throw new Error(`toMicroUsdcEquivalent: no USDC rate for asset ${asset}`);
}
