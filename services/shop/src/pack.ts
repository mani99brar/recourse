// The shop's packed record: what it sent for a paid order, written from the shop's own account
// when the order leaves. The attributes are the shop's catalogue entry for the paid item and the
// price it charged, unless the shop states what it actually packed.

import { formatUnits, type Address, type Hex } from 'viem';
import { RecordKind, canonicalBytes, partyWithRole, type Attrs, type CanonicalValue, type Parties, type RecordRefs } from '@recourse/shared';
import type { Journal, Logger, RecordsClient, TopicReader } from '@recourse/records';
import { itemBySku, offerAttrs } from './catalog.js';
import { OrderBook, type OrderView, type RecordRef, type ShopJournalRow } from './orders.js';
import { HBAR_ASSET_ID } from './payments.js';

/** Price text for a settled amount: "1.5 USDC" or, for 150000000 tinybar, "1.5 HBAR". */
export function chargedPrice(amount: string, asset: string): string {
  return asset === HBAR_ASSET_ID ? `${formatUnits(BigInt(amount), 8)} HBAR` : `${formatUnits(BigInt(amount), 6)} USDC`;
}

export function packedDoc(input: { orderId: Hex; attrs: Attrs; packedAt: number }): Uint8Array {
  const attrs: Record<string, CanonicalValue> = {};
  for (const [k, v] of Object.entries(input.attrs)) if (typeof v === 'string') attrs[k] = v;
  return canonicalBytes({ v: '1', kind: 'packed', orderId: input.orderId, attrs, packedAt: String(input.packedAt) });
}

type PackDraftRow = Extract<ShopJournalRow, { type: 'pack_draft' }>;

/** The packed document journaled for an order before its commit, if any; a rerun commits this one. */
export function journaledDraft(rows: readonly ShopJournalRow[], orderId: Hex): { row: PackDraftRow; text: string; attrs: Record<string, string> } | null {
  const row = rows.filter((r): r is PackDraftRow => r.type === 'pack_draft' && r.orderId.toLowerCase() === orderId.toLowerCase()).at(-1);
  if (!row) return null;
  const text = Buffer.from(row.doc.slice(2), 'hex').toString('utf8');
  const parsed = JSON.parse(text) as { attrs?: Record<string, unknown> };
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.attrs ?? {})) if (typeof v === 'string') attrs[k] = v;
  return { row, text, attrs };
}

/** The keys whose value differs between two attribute sets (string values only, as packedDoc keeps). */
export function attrsDiffer(a: Attrs, b: Record<string, string>): string[] {
  const own: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) if (typeof v === 'string') own[k] = v;
  return [...new Set([...Object.keys(own), ...Object.keys(b)])].filter((k) => own[k] !== b[k]).sort();
}

/** What confirms an order the shop journaled as paid but never confirmed: the records topic and the party map. */
export interface PackConfirm {
  reader: Pick<TopicReader, 'refsFor'>;
  parties: Parties;
  /** The shop's EVM address, the order id's shop. */
  shop: Address;
}

/**
 * The asked, shown and approval refs that confirm a `paid_unconfirmed` order: its platform's own
 * records on the topic (the same ones the shop's paid request would have carried), and its payer
 * one of that platform's record writers, as the shop checks before it settles. Throws when any is
 * missing.
 */
export async function confirmationRefs(order: OrderView, confirm: PackConfirm): Promise<{ asked: RecordRef; shown: RecordRef; approval: RecordRef }> {
  const platform = partyWithRole(confirm.parties, 'platform', order.platform);
  if (!platform) throw new Error(`order ${order.orderId}: ${order.platform} is not a platform in the party map`);
  if (!platform.hcsWriters.includes(order.payment.payer)) {
    throw new Error(`order ${order.orderId}: the payer ${order.payment.payer} is not a record writer of its platform`);
  }
  const refs: RecordRefs = await confirm.reader.refsFor(order.orderId, confirm.parties, { platform: order.platform, shop: confirm.shop });
  const kinds = [
    ['asked', RecordKind.Asked],
    ['shown', RecordKind.Shown],
    ['approval', RecordKind.Approval],
  ] as const;
  const missing = kinds.filter(([, k]) => refs.seq[k] === 0n).map(([name]) => name);
  if (missing.length > 0) throw new Error(`order ${order.orderId}: the topic has no ${missing.join(', ')} record from its platform`);
  const ref = (k: RecordKind): RecordRef => ({ seq: refs.seq[k]!.toString(), hash: refs.hashes[k]! });
  return { asked: ref(RecordKind.Asked), shown: ref(RecordKind.Shown), approval: ref(RecordKind.Approval) };
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
 * A rerun given attributes other than the journaled document's is refused, never silently
 * dropped. An order journaled as paid but never confirmed (`paid_unconfirmed`) is confirmed first
 * from the topic with `confirm` (its platform's asked, shown and approval records) and an
 * `order_confirmed` row; without `confirm` it is refused.
 */
export async function packOrder(deps: {
  records: RecordsClient;
  journal: Journal<ShopJournalRow>;
  orderId: Hex;
  merchant: string;
  /** What was packed, when it is not the catalogue entry. */
  attrs?: Attrs;
  /** Confirms a `paid_unconfirmed` order from the topic before packing it. */
  confirm?: PackConfirm;
  now?: () => number;
  log?: Logger;
}): Promise<Packed> {
  const rows = deps.journal.read().rows;
  const book = new OrderBook();
  for (const row of rows) book.apply(row);
  const order = book.get(deps.orderId);
  if (!order) throw new Error(`no paid order ${deps.orderId} in the shop journal`);
  if (order.packed) return { orderId: order.orderId, ...order.packed, existing: true };
  if (order.status === 'paid_unconfirmed' && deps.confirm) {
    const refs = await confirmationRefs(order, deps.confirm);
    deps.journal.append({ type: 'order_confirmed', at: new Date().toISOString(), orderId: order.orderId, refs });
    deps.log?.warn('order_confirmed_from_topic', { orderId: order.orderId, asked: refs.asked.seq, shown: refs.shown.seq, approval: refs.approval.seq });
  } else if (order.status !== 'paid') {
    const hint = order.status === 'paid_unconfirmed' ? ' (pack confirms it from the records topic when the party map is set)' : '';
    throw new Error(`order ${order.orderId} is ${order.status}; only a confirmed paid order is packed${hint}`);
  }
  const item = itemBySku(order.sku);
  if (!item) throw new Error(`order ${order.orderId} names unknown item ${order.sku}`);

  const journaled = journaledDraft(rows, order.orderId);
  if (journaled && deps.attrs) {
    const given = deps.attrs as Record<string, unknown>;
    const differs = attrsDiffer(deps.attrs, journaled.attrs);
    if (differs.length > 0) {
      const show = (v: unknown) => (typeof v === 'string' ? v : '(none)');
      throw new Error(
        `order ${order.orderId}: the packed record journaled at ${journaled.row.at} (and maybe already on the topic) says ${differs.map((k) => `${k}=${show(journaled.attrs[k])}`).join(', ')}; ` +
          `a rerun commits that document, not the attributes given (${differs.map((k) => `${k}=${show(given[k])}`).join(', ')}): ${journaled.text}`,
      );
    }
  }
  let draft = journaled?.row;
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
