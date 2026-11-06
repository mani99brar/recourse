import { afterEach, describe, expect, test } from 'vitest';
import { HBAR_ASSET_ID, toMicroUsdcEquivalent } from '@recourse/shared';
import { CATALOG, MAX_QUANTITY, basketPrice } from '../src/catalog.js';
import { loadShopConfig } from '../src/config.js';
import { USDC_TOKEN_ID } from '../src/payments.js';
import { fakeFacilitator } from './fake-facilitator.js';
import { startTestShop } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe('basket prices', () => {
  test('in USDC the 402 amount is the list price; in HBAR it is 1 HBAR per USDC', () => {
    const tee = CATALOG.find((i) => i.sku === 'tee-navy-l')!;
    expect(basketPrice(tee, 1, 'usdc')).toEqual({ amount: '1500000', asset: USDC_TOKEN_ID });
    expect(basketPrice(tee, 1, 'hbar')).toEqual({ amount: '150000000', asset: HBAR_ASSET_ID });
    const hoodie = CATALOG.find((i) => i.sku === 'hoodie-grey-m')!;
    expect(basketPrice(hoodie, 3, 'hbar')).toEqual({ amount: '1800000000', asset: HBAR_ASSET_ID });
  });

  test('every HBAR basket converts back to its USDC list price at the shared rate', () => {
    for (const item of CATALOG) {
      for (let q = 1; q <= MAX_QUANTITY; q++) {
        const hbar = basketPrice(item, q, 'hbar');
        expect(toMicroUsdcEquivalent(BigInt(hbar.amount), hbar.asset), `${item.sku} x${q}`).toBe(item.unitUsdc * BigInt(q));
      }
    }
  });
});

describe('PRICE_ASSET', () => {
  const env = { HEDERA_ACCOUNT_IDS: 'shop=0.0.990100', X402_FACILITATOR_URLS: 'https://facilitator.invalid', HCS_RECORDS_TOPIC_ID: '0.0.7000001' };

  test('is read in any case and refused when unknown', () => {
    expect(loadShopConfig(env, { stateDir: '/nonexistent' }).priceAsset).toBe('usdc');
    expect(loadShopConfig({ ...env, PRICE_ASSET: 'HBAR' }, { stateDir: '/nonexistent' }).priceAsset).toBe('hbar');
    expect(() => loadShopConfig({ ...env, PRICE_ASSET: 'dollars' }, { stateDir: '/nonexistent' })).toThrow('PRICE_ASSET: expected usdc or hbar');
  });

  test('in HBAR mode the catalogue and the registration document name the HBAR asset', async () => {
    const shop = await startTestShop([fakeFacilitator()], { priceAsset: 'hbar' });
    cleanup = shop.close;
    const catalog = (await (await fetch(`${shop.url}/catalog`)).json()) as { asset: string; items: { sku: string; quantities: { price: { amount: string; asset: string } }[] }[] };
    expect(catalog.asset).toBe(HBAR_ASSET_ID);
    expect(catalog.items.find((i) => i.sku === 'cap-red')!.quantities[0]!.price).toEqual({ amount: '100000000', asset: HBAR_ASSET_ID });
    const reg = (await (await fetch(`${shop.url}/.well-known/agent-registration.json`)).json()) as { services: { asset: string }[] };
    expect(reg.services[0]!.asset).toBe(HBAR_ASSET_ID);
  });
});
