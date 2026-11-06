// The shop's catalogue. Every brand and item is fictional. Each (sku, quantity) pair is its own paid
// route, so the price in the 402 is always the exact basket total. SHOP_CATALOG_FILE, when set, names
// a JSON file that replaces the built-in list (the demo cast's shops sell from one each).

import { readFileSync } from 'node:fs';
import { TINYBAR_PER_MICRO_USDC, priceAssetIdOf, type Attrs, type ParseResult, type PriceAsset } from '@recourse/shared';
import type { Price } from './payments.js';

type Env = Record<string, string | undefined>;

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

export const BUILT_IN_CATALOG: readonly CatalogItem[] = [
  { sku: 'tee-navy-m', title: 'Organic cotton tee', brand: 'Northwind', size: 'M', colour: 'Navy', unitUsdc: 1_500_000n },
  { sku: 'tee-navy-l', title: 'Organic cotton tee', brand: 'Northwind', size: 'L', colour: 'Navy', unitUsdc: 1_500_000n },
  { sku: 'cap-red', title: 'Six-panel cap', brand: 'Northwind', size: 'One size', colour: 'Red', unitUsdc: 1_000_000n },
  { sku: 'hoodie-grey-m', title: 'Fleece hoodie', brand: 'Northwind', size: 'M', colour: 'Grey', unitUsdc: 6_000_000n },
];

const ITEM_KEYS = new Set(['sku', 'title', 'brand', 'size', 'colour', 'unitUsdc']);
/** The order route's sku pattern (app.ts parses `/x402/orders/<sku>/<quantity>` with it). */
const SKU = /^[a-z0-9-]+$/;
const MICRO = /^[1-9]\d*$/;

/**
 * Validates a catalogue file's parsed JSON: a non-empty array of items with the built-in fields, a
 * unique route-safe sku, non-empty text fields and a positive unit price in micro-USDC (a whole
 * number, as a string or a safe integer). Returns the first problem found.
 */
export function parseCatalog(json: unknown): ParseResult<CatalogItem[]> {
  if (!Array.isArray(json) || json.length === 0) return { ok: false, error: 'catalogue: expected a non-empty JSON array' };
  const out: CatalogItem[] = [];
  const skus = new Set<string>();
  for (const [i, entry] of json.entries()) {
    const at = `catalogue[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { ok: false, error: `${at}: expected an object` };
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) if (!ITEM_KEYS.has(key)) return { ok: false, error: `${at}: unknown field ${key}` };
    if (typeof e.sku !== 'string' || !SKU.test(e.sku)) return { ok: false, error: `${at}.sku: expected lower-case letters, digits and dashes` };
    if (skus.has(e.sku)) return { ok: false, error: `${at}.sku: duplicate ${e.sku}` };
    skus.add(e.sku);
    for (const key of ['title', 'brand', 'size', 'colour'] as const) {
      if (typeof e[key] !== 'string' || (e[key] as string).trim() === '') return { ok: false, error: `${at}.${key}: expected a non-empty string` };
    }
    const price = typeof e.unitUsdc === 'number' && Number.isSafeInteger(e.unitUsdc) ? String(e.unitUsdc) : e.unitUsdc;
    if (typeof price !== 'string' || !MICRO.test(price)) return { ok: false, error: `${at}.unitUsdc: expected a positive whole number of micro-USDC` };
    out.push({ sku: e.sku, title: e.title as string, brand: e.brand as string, size: e.size as string, colour: e.colour as string, unitUsdc: BigInt(price) });
  }
  return { ok: true, value: out };
}

/** SHOP_CATALOG_FILE's catalogue when the variable is set (an unreadable or invalid file throws), else the built-in one. */
export function loadCatalog(env: Env = process.env): readonly CatalogItem[] {
  const path = env.SHOP_CATALOG_FILE;
  if (!path) return BUILT_IN_CATALOG;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`SHOP_CATALOG_FILE: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseCatalog(json);
  if (!parsed.ok) throw new Error(`SHOP_CATALOG_FILE: ${parsed.error}`);
  return parsed.value;
}

/**
 * What this process sells, read once when the module loads: the shop's routes and pack records and
 * live-order's prices all come from the same list.
 */
export const CATALOG: readonly CatalogItem[] = loadCatalog();

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
