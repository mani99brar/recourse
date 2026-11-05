// What the shop files for an order, read from its own journal and the records topic: the order
// nonce and platform from the shop's payment record, the basket from what was settled, and the
// record pointers from the topic. The ordered record must carry the settlement the shop journaled,
// so a claim is only filed for an order the shop was actually paid for.

import type { Hex } from 'viem';
import { RecordKind, type Parties } from '@recourse/shared';
import type { TopicReader } from '@recourse/records';
import { basketPrice, itemBySku } from './catalog.js';
import type { FileClaimInput } from './filing.js';
import { OrderBook, type ShopJournalRow } from './orders.js';
import { USDC_TOKEN_ID } from './payments.js';

export type ClaimInputErrorCode = 'not_paid' | 'no_ordered_record' | 'ordered_tx_mismatch' | 'ordered_unreadable';

export class ClaimInputError extends Error {
  constructor(
    readonly code: ClaimInputErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ClaimInputError';
  }
}

export async function claimInputFor(deps: {
  rows: readonly ShopJournalRow[];
  reader: TopicReader;
  parties: Parties;
  orderId: Hex;
  /** µUSDC claimed; default the whole basket. */
  netLossUsdc?: bigint;
  /** Fetches a record document by CID, checked against its hash. */
  fetchDoc: (cid: string, hash: Hex) => Promise<Uint8Array>;
}): Promise<FileClaimInput & { orderId: Hex; settlement: string }> {
  const book = new OrderBook();
  for (const row of deps.rows) book.apply(row);
  const order = book.get(deps.orderId);
  if (!order || order.status === 'payer_mismatch') {
    throw new ClaimInputError('not_paid', `the shop journal has no payment it accepted for ${deps.orderId}`);
  }
  const item = itemBySku(order.sku);
  const basketUsdc =
    order.payment.asset === USDC_TOKEN_ID ? BigInt(order.payment.amount) : item ? BigInt(basketPrice(item, order.quantity, 'usdc').amount) : 0n;

  const refs = await deps.reader.refsFor(order.orderId, deps.parties);
  const seq = refs.seq[RecordKind.Ordered]!;
  if (seq === 0n) throw new ClaimInputError('no_ordered_record', `no ordered record for ${order.orderId} on the topic yet`);
  const message = (await deps.reader.readOrderRecords(order.orderId)).find((m) => BigInt(m.seq) === seq);
  if (!message) throw new ClaimInputError('no_ordered_record', `ordered record ${seq} not found`);
  let x402TxId: unknown;
  try {
    x402TxId = (JSON.parse(new TextDecoder().decode(await deps.fetchDoc(message.cid, message.hash))) as { x402TxId?: unknown }).x402TxId;
  } catch (error) {
    throw new ClaimInputError('ordered_unreadable', `ordered record ${message.cid}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (x402TxId !== order.payment.txId) {
    throw new ClaimInputError('ordered_tx_mismatch', `ordered record names ${String(x402TxId)}, the shop settled ${order.payment.txId}`);
  }
  return { orderId: order.orderId, orderNonce: order.orderNonce, platform: order.platform, refs, basketUsdc, netLossUsdc: deps.netLossUsdc ?? basketUsdc, settlement: order.payment.txId };
}
