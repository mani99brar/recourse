// The shop's catalogue. Every brand and item is fictional. Each (sku, quantity) pair is its own paid
// route, so the price in the 402 is always the exact basket total.

import { TINYBAR_PER_MICRO_USDC, priceAssetIdOf, type Attrs, type PriceAsset } from '@recourse/shared';
import type { Price } from './payments.js';

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

export function itemBySku(sku: string): CatalogItem | undefined {
  return CATALOG.find((i) => i.sku === sku);
}

export function orderPath(sku: string, quantity: number): string {
  return `${ORDER_ROUTE_PREFIX}/${sku}/${quantity}`;
}

/** The basket total in the price asset; in HBAR at the shared rate (1 USDC of list price = 1 HBAR). */
export function basketPrice(item: CatalogItem, quantity: number, asset: PriceAsset): Price {
  const usdc = item.unitUsdc * BigInt(quantity);
  const amount = asset === 'hbar' ? usdc * TINYBAR_PER_MICRO_USDC : usdc;
  return { amount: amount.toString(), asset: priceAssetIdOf(asset) };
}

/** The offer as record attributes. The price is not here: it is the 402 amount. */
export function offerAttrs(item: CatalogItem, quantity: number, merchant: string): Omit<Attrs, 'price'> {
  return { brand: item.brand, size: item.size, colour: item.colour, quantity: String(quantity), merchant };
}
