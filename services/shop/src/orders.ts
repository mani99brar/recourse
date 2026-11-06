// The shop's journal and the order book replayed from it. The journal is append-only JSONL; a paid
// order is journaled by the after-settle hook before its handler runs, so a handler that fails
// after the money moved still leaves the order visible (`paid_unconfirmed`). A settle that failed
// after the facilitator may have submitted is journaled as `settle_unknown` and resolved against
// the mirror node (reconcile.ts).

import { z } from 'zod';
import type { Address, Hex } from 'viem';
import { isHex32 } from '@recourse/shared';

const hex32 = z.string().refine((v) => isHex32(v), 'expected 0x + 64 lowercase hex');
const seq = z.string().regex(/^[1-9]\d{0,18}$/, 'expected a positive decimal sequence number');
const ref = z.object({ seq, hash: hex32 }).strict();

/** Body of a paid order request: the order id and the three records the agent wrote before paying. */
export const OrderBody = z
  .object({
    orderId: hex32,
    refs: z.object({ asked: ref, shown: ref, approval: ref }).strict(),
  })
  .strict();
export type OrderBody = z.infer<typeof OrderBody>;

/** Body of a complaint: a pointer to the agent's arrived record. Free text is never accepted. */
export const ComplaintBody = z.object({ orderId: hex32, seq, hash: hex32, cid: z.string().min(1).max(128) }).strict();
export type ComplaintBody = z.infer<typeof ComplaintBody>;

export interface RecordRef {
  seq: string;
  hash: Hex;
}

type At = { at: string };

export type ShopJournalRow =
  | (At & { type: 'settled'; route: string; txId: string; payer: string; amount: string; asset: string; payTo: string })
  | (At & { type: 'ping_paid'; txId: string; payer: string; amount: string; asset: string })
  | (At & {
      type: 'order_paid';
      orderId: Hex;
      orderNonce: Hex;
      platform: Address;
      sku: string;
      quantity: number;
      txId: string;
      payer: string;
      amount: string;
      asset: string;
      payTo: string;
    })
  | (At & { type: 'order_confirmed'; orderId: Hex; refs: { asked: RecordRef; shown: RecordRef; approval: RecordRef } })
  | (At & { type: 'payer_mismatch'; orderId: Hex; payer: string; txId: string })
  /**
   * A verified payment for an order whose settle failed in a way that may still have moved the money
   * (the reply timed out or errored after submitting). `txId` is the Hedera transaction id signed
   * into the payment; the mirror node decides what became of it (`settle_resolved`).
   */
  | (At & {
      type: 'settle_unknown';
      orderId: Hex;
      orderNonce: Hex;
      platform: Address;
      sku: string;
      quantity: number;
      txId: string;
      payer: string;
      amount: string;
      asset: string;
      payTo: string;
      reason: string;
      refs: { asked: RecordRef; shown: RecordRef; approval: RecordRef } | null;
    })
  | (At & { type: 'settle_resolved'; orderId: Hex; txId: string; outcome: 'paid' | 'duplicate' | 'dead'; reason: string })
  /** A second payment that settled for an order already paid: shown on the order for a refund. */
  | (At & { type: 'duplicate_payment'; orderId: Hex; txId: string; payer: string; amount: string; asset: string; payTo: string })
  /** The packed record's document, journaled before it is committed so a rerun commits the same bytes. */
  | (At & { type: 'pack_draft'; orderId: Hex; doc: Hex })
  | (At & { type: 'packed'; orderId: Hex; seq: number; hash: Hex; cid: string })
  | (At & { type: 'complaint'; orderId: Hex; seq: string; hash: Hex; cid: string });

export type OrderStatus = 'paid_unconfirmed' | 'paid' | 'payer_mismatch' | 'packed';

export interface OrderView {
  orderId: Hex;
  orderNonce: Hex;
  platform: Address;
  sku: string;
  quantity: number;
  status: OrderStatus;
  payment: { txId: string; payer: string; amount: string; asset: string; payTo: string; at: string };
  refs: { asked: RecordRef; shown: RecordRef; approval: RecordRef } | null;
  packed: { seq: number; hash: Hex; cid: string } | null;
  complaint: { seq: string; hash: Hex; cid: string } | null;
  /** Payments settled for this order after the first one; each is owed back. */
  duplicatePayments: { txId: string; payer: string; amount: string; asset: string; at: string }[];
}

export type SettleUnknownRow = Extract<ShopJournalRow, { type: 'settle_unknown' }>;

export class OrderBook {
  private readonly orders = new Map<string, OrderView>();
  /** Orders whose paid request is being processed right now, with the time it started. */
  private readonly inFlight = new Map<string, number>();
  /** Settles of unknown outcome, by Hedera transaction id, and the ids already resolved. */
  private readonly unknown = new Map<string, SettleUnknownRow>();
  private readonly resolved = new Set<string>();

  /** Applying the same row twice changes nothing, so a book can replay a journal it partly holds. */
  apply(row: ShopJournalRow): void {
    if (row.type === 'settle_unknown') {
      if (!this.unknown.has(row.txId)) this.unknown.set(row.txId, row);
      return;
    }
    if (row.type === 'settle_resolved') {
      this.resolved.add(row.txId);
      return;
    }
    if (row.type === 'order_paid') {
      if (this.orders.has(row.orderId)) return;
      this.orders.set(row.orderId, {
        orderId: row.orderId,
        orderNonce: row.orderNonce,
        platform: row.platform,
        sku: row.sku,
        quantity: row.quantity,
        status: 'paid_unconfirmed',
        payment: { txId: row.txId, payer: row.payer, amount: row.amount, asset: row.asset, payTo: row.payTo, at: row.at },
        refs: null,
        packed: null,
        complaint: null,
        duplicatePayments: [],
      });
      return;
    }
    if (row.type === 'settled' || row.type === 'ping_paid') return;
    const order = this.orders.get(row.orderId);
    if (!order) return;
    if (row.type === 'duplicate_payment') {
      if (row.txId !== order.payment.txId && !order.duplicatePayments.some((d) => d.txId === row.txId)) {
        order.duplicatePayments.push({ txId: row.txId, payer: row.payer, amount: row.amount, asset: row.asset, at: row.at });
      }
      return;
    }
    if (row.type === 'order_confirmed' && order.status === 'paid_unconfirmed') {
      order.refs = row.refs;
      order.status = 'paid';
    }
    if (row.type === 'payer_mismatch') order.status = 'payer_mismatch';
    if (row.type === 'packed' && !order.packed) {
      order.packed = { seq: row.seq, hash: row.hash, cid: row.cid };
      order.status = 'packed';
    }
    if (row.type === 'complaint' && !order.complaint) order.complaint = { seq: row.seq, hash: row.hash, cid: row.cid };
  }

  get(orderId: string): OrderView | undefined {
    return this.orders.get(orderId.toLowerCase());
  }

  all(): OrderView[] {
    return [...this.orders.values()];
  }

  /** Settles of unknown outcome not yet resolved, oldest first; only the order's when one is named. */
  openSettlements(orderId?: string): SettleUnknownRow[] {
    const only = orderId?.toLowerCase();
    return [...this.unknown.values()].filter(
      (u) =>
        !this.resolved.has(u.txId) &&
        (only === undefined || u.orderId.toLowerCase() === only) &&
        this.orders.get(u.orderId)?.payment.txId !== u.txId,
    );
  }

  /** Marks a paid request as started; false when another is already running for the order. */
  begin(orderId: string, now = Date.now(), staleMs = 120_000): boolean {
    const started = this.inFlight.get(orderId);
    if (started !== undefined && now - started < staleMs) return false;
    this.inFlight.set(orderId, now);
    return true;
  }

  end(orderId: string): void {
    this.inFlight.delete(orderId);
  }

  isInFlight(orderId: string, now = Date.now(), staleMs = 120_000): boolean {
    const started = this.inFlight.get(orderId);
    return started !== undefined && now - started < staleMs;
  }
}
