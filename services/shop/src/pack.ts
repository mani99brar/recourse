// The shop's packed record: what it sent for a paid order, written from the shop's own account
// when the order leaves. The attributes are the shop's catalogue entry for the paid item and the
// price it charged, unless the shop states what it actually packed.

import { formatUnits, type Hex } from 'viem';
import { RecordKind, canonicalBytes, type Attrs, type CanonicalValue } from '@recourse/shared';
import type { Journal, Logger, RecordsClient } from '@recourse/records';
import { itemBySku, offerAttrs } from './catalog.js';
import { OrderBook, type ShopJournalRow } from './orders.js';
import { HBAR_ASSET_ID } from './payments.js';

/** Price text for a settled amount: "1.50 USDC" or "150 HBAR". */
export function chargedPrice(amount: string, asset: string): string {
  return asset === HBAR_ASSET_ID ? `${formatUnits(BigInt(amount), 8)} HBAR` : `${formatUnits(BigInt(amount), 6)} USDC`;
}

export function packedDoc(input: { orderId: Hex; attrs: Attrs; packedAt: number }): Uint8Array {
  const attrs: Record<string, CanonicalValue> = {};
  for (const [k, v] of Object.entries(input.attrs)) if (typeof v === 'string') attrs[k] = v;
  return canonicalBytes({ v: '1', kind: 'packed', orderId: input.orderId, attrs, packedAt: String(input.packedAt) });
}

export interface Packed {
  orderId: Hex;
  seq: number;
  hash: Hex;
  cid: string;
  /** True when the order was already packed; nothing new was written. */
  existing: boolean;
}

/**
 * Commits the packed record of a paid order and journals it. Idempotent: an order already packed
 * returns its record, and a rerun after a crash commits the same document again (the records
 * client then finds the first one), because the document is journaled before it is committed.
 */
export async function packOrder(deps: {
  records: RecordsClient;
  journal: Journal<ShopJournalRow>;
  orderId: Hex;
  merchant: string;
  /** What was packed, when it is not the catalogue entry. */
  attrs?: Attrs;
  now?: () => number;
  log?: Logger;
}): Promise<Packed> {
  const rows = deps.journal.read().rows;
  const book = new OrderBook();
  for (const row of rows) book.apply(row);
  const order = book.get(deps.orderId);
  if (!order) throw new Error(`no paid order ${deps.orderId} in the shop journal`);
  if (order.packed) return { orderId: order.orderId, ...order.packed, existing: true };
  if (order.status !== 'paid') throw new Error(`order ${order.orderId} is ${order.status}; only a confirmed paid order is packed`);
  const item = itemBySku(order.sku);
  if (!item) throw new Error(`order ${order.orderId} names unknown item ${order.sku}`);

  let draft = rows.filter((r): r is Extract<ShopJournalRow, { type: 'pack_draft' }> => r.type === 'pack_draft' && r.orderId === order.orderId).at(-1);
  if (!draft) {
    const attrs = deps.attrs ?? { ...offerAttrs(item, order.quantity, deps.merchant), price: chargedPrice(order.payment.amount, order.payment.asset) };
    const doc = packedDoc({ orderId: order.orderId, attrs, packedAt: (deps.now ?? (() => Math.floor(Date.now() / 1000)))() });
    draft = { type: 'pack_draft', at: new Date().toISOString(), orderId: order.orderId, doc: `0x${Buffer.from(doc).toString('hex')}` as Hex };
    deps.journal.append(draft);
  }
  const committed = await deps.records.commitRecord(RecordKind.Packed, order.orderId, new Uint8Array(Buffer.from(draft.doc.slice(2), 'hex')));
  deps.journal.append({ type: 'packed', at: new Date().toISOString(), orderId: order.orderId, seq: committed.seq, hash: committed.hash, cid: committed.cid });
  deps.log?.info('order_packed', { orderId: order.orderId, seq: committed.seq, cid: committed.cid, simulated: committed.simulated });
  return { orderId: order.orderId, seq: committed.seq, hash: committed.hash, cid: committed.cid, existing: false };
}
