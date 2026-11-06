import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { HBAR_ASSET_ID, toMicroUsdcEquivalent } from '@recourse/shared';
import { BUILT_IN_CATALOG, CATALOG, MAX_QUANTITY, basketPrice, loadCatalog, offerAttrs, parseCatalog } from '../src/catalog.js';
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

describe('SHOP_CATALOG_FILE', () => {
  const beans = { sku: 'beans-250g', title: 'Whole coffee beans', brand: 'Fernhill Roasters', size: '250 g', colour: 'Medium roast', unitUsdc: '2500000' };

  test('unset, the built-in catalogue is sold, and it passes the file validation itself', () => {
    expect(CATALOG).toBe(BUILT_IN_CATALOG);
    expect(loadCatalog({})).toBe(BUILT_IN_CATALOG);
    const asJson = JSON.parse(JSON.stringify(BUILT_IN_CATALOG, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as unknown;
    expect(parseCatalog(asJson)).toEqual({ ok: true, value: [...BUILT_IN_CATALOG] });
  });

  test('set, its items replace the built-in ones and price and describe orders the same way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
    const file = join(dir, 'catalogue.json');
    writeFileSync(file, JSON.stringify([beans, { ...beans, sku: 'beans-1kg', size: '1 kg', unitUsdc: 8_000_000 }]));
    const items = loadCatalog({ SHOP_CATALOG_FILE: file });
    expect(items.map((i) => i.sku)).toEqual(['beans-250g', 'beans-1kg']);
    expect(basketPrice(items[1]!, 2, 'usdc')).toEqual({ amount: '16000000', asset: USDC_TOKEN_ID });
    expect(offerAttrs(items[0]!, 1, 'Example Shop')).toEqual({ brand: 'Fernhill Roasters', size: '250 g', colour: 'Medium roast', quantity: '1', merchant: 'Example Shop' });
  });

  test.each([
    ['an empty list', []],
    ['an object', { items: [] }],
    ['a sku the order route cannot carry', [{ ...beans, sku: 'Beans 250' }]],
    ['a duplicate sku', [beans, beans]],
    ['an empty size', [{ ...beans, size: ' ' }]],
    ['a missing colour', [{ ...beans, colour: undefined }]],
    ['a price in USDC rather than micro-USDC', [{ ...beans, unitUsdc: '2.50' }]],
    ['a zero price', [{ ...beans, unitUsdc: 0 }]],
    ['an unknown field', [{ ...beans, lateRefund: true }]],
  ])('refuses %s', (_label, json) => {
    expect(parseCatalog(JSON.parse(JSON.stringify(json))).ok).toBe(false);
  });

  test('a file that is missing or not JSON stops the shop, naming the variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
    writeFileSync(join(dir, 'bad.json'), '[{');
    expect(() => loadCatalog({ SHOP_CATALOG_FILE: join(dir, 'missing.json') })).toThrow(/^SHOP_CATALOG_FILE: /);
    expect(() => loadCatalog({ SHOP_CATALOG_FILE: join(dir, 'bad.json') })).toThrow(/^SHOP_CATALOG_FILE: /);
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
