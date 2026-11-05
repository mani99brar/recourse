// The shop's catalogue. Every brand and item is fictional. Each (sku, quantity) pair is its own paid
// route, so the price in the 402 is always the exact basket total.

import type { Attrs } from '@recourse/shared';
import { HBAR_ASSET_ID, USDC_TOKEN_ID, type Price } from './payments.js';
import type { PriceAsset } from './config.js';

export const MAX_QUANTITY = 3;
export const ORDER_ROUTE_PREFIX = '/x402/orders';

export interface CatalogItem {
  sku: string;
  title: string;
  brand: string;
  size: string;
  colour: string;
  /** Unit price in micro-USDC. */
  unitUsdc: bigint;
}

export const CATALOG: readonly CatalogItem[] = [
  { sku: 'tee-navy-m', title: 'Organic cotton tee', brand: 'Northwind', size: 'M', colour: 'Navy', unitUsdc: 1_500_000n },
  { sku: 'tee-navy-l', title: 'Organic cotton tee', brand: 'Northwind', size: 'L', colour: 'Navy', unitUsdc: 1_500_000n },
  { sku: 'cap-red', title: 'Six-panel cap', brand: 'Northwind', size: 'One size', colour: 'Red', unitUsdc: 1_000_000n },
  { sku: 'hoodie-grey-m', title: 'Fleece hoodie', brand: 'Northwind', size: 'M', colour: 'Grey', unitUsdc: 6_000_000n },
];

/** HBAR prices, used only when the shop is set to price in HBAR: 1 µUSDC = 100 tinybar. */
const TINYBAR_PER_MICRO_USDC = 100n;

export function itemBySku(sku: string): CatalogItem | undefined {
  return CATALOG.find((i) => i.sku === sku);
}

export function orderPath(sku: string, quantity: number): string {
  return `${ORDER_ROUTE_PREFIX}/${sku}/${quantity}`;
}

export function basketPrice(item: CatalogItem, quantity: number, asset: PriceAsset): Price {
  const usdc = item.unitUsdc * BigInt(quantity);
  return asset === 'hbar'
    ? { amount: (usdc * TINYBAR_PER_MICRO_USDC).toString(), asset: HBAR_ASSET_ID }
    : { amount: usdc.toString(), asset: USDC_TOKEN_ID };
}

/** The offer as record attributes. The price is not here: it is the 402 amount. */
export function offerAttrs(item: CatalogItem, quantity: number, merchant: string): Omit<Attrs, 'price'> {
  return { brand: item.brand, size: item.size, colour: item.colour, quantity: String(quantity), merchant };
}
