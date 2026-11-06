import { describe, expect, it } from 'vitest';
import { HBAR_ASSET_ID, TINYBAR_PER_MICRO_USDC, addressBook, priceAssetIdOf, priceAssetOf, toMicroUsdcEquivalent } from '../src/index.js';

const USDC = addressBook.hedera.usdc.tokenId;

describe('price asset', () => {
  it('reads PRICE_ASSET, usdc by default, and refuses anything else', () => {
    expect(priceAssetOf({})).toBe('usdc');
    expect(priceAssetOf({ PRICE_ASSET: '' })).toBe('usdc');
    expect(priceAssetOf({ PRICE_ASSET: 'usdc' })).toBe('usdc');
    expect(priceAssetOf({ PRICE_ASSET: 'HBAR' })).toBe('hbar');
    expect(() => priceAssetOf({ PRICE_ASSET: 'hbar ' })).toThrow('PRICE_ASSET: expected usdc or hbar');
    expect(() => priceAssetOf({ PRICE_ASSET: 'eth' })).toThrow('PRICE_ASSET: expected usdc or hbar');
  });

  it('maps each price asset to its x402 asset id', () => {
    expect(HBAR_ASSET_ID).toBe('0.0.0');
    expect(priceAssetIdOf('hbar')).toBe('0.0.0');
    expect(priceAssetIdOf('usdc')).toBe('0.0.429274');
  });

  it('gives the micro-USDC equivalent of an x402 amount', () => {
    expect(TINYBAR_PER_MICRO_USDC).toBe(100n);
    expect(toMicroUsdcEquivalent(1_500_000n, USDC)).toBe(1_500_000n);
    // 1.5 HBAR is 1.5 USDC of list price.
    expect(toMicroUsdcEquivalent(150_000_000n, HBAR_ASSET_ID)).toBe(1_500_000n);
    expect(toMicroUsdcEquivalent(0n, HBAR_ASSET_ID)).toBe(0n);
    // A tinybar remainder rounds up, never down under a limit.
    expect(toMicroUsdcEquivalent(500_000_001n, HBAR_ASSET_ID)).toBe(5_000_001n);
    expect(toMicroUsdcEquivalent(99n, HBAR_ASSET_ID)).toBe(1n);
  });

  it('refuses an asset it has no rate for, and a negative amount', () => {
    expect(() => toMicroUsdcEquivalent(1n, '0.0.777')).toThrow('no USDC rate for asset 0.0.777');
    expect(() => toMicroUsdcEquivalent(-1n, USDC)).toThrow(RangeError);
  });
});
