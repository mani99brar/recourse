// Settles the shop never heard back about. When a facilitator's settle reply times out or errors
// after it submitted the transfer, no after-settle hook runs, and the agent may still see the
// transfer succeed on the mirror node. The shop journals such a payment as `settle_unknown` with the
// Hedera transaction id signed into it, and this module asks the mirror node what became of it:
//
//   SUCCESS, moving exactly the price from the payer to the shop  -> the order is paid with that id
//     (order_paid, and order_confirmed when the request carried the record refs); a second payment
//     for an order already paid is journaled as `duplicate_payment`, owed back
//   any other result, or a transfer that does not match           -> dead
//   not on the mirror node past the payment's validity window      -> dead (expired unseen)
//   otherwise                                                      -> still open; asked again later
//
// Run at boot, on GET /orders/:id and from the order gate in the shop, and by `pnpm reconcile`.

import { validStartSeconds, type MirrorTransaction } from '@recourse/records';
import { OrderBook, type SettleUnknownRow, type ShopJournalRow } from './orders.js';
import { HBAR_ASSET_ID } from './payments.js';

/**
 * A payment not on the mirror node by its valid start + this many seconds can no longer reach
 * consensus: the validity window is 120 s, the rest is margin for mirror lag. The agent uses the same.
 */
export const SETTLE_DEAD_AFTER_S = 240;

export interface MirrorTxReader {
  transaction(txId: string): Promise<MirrorTransaction | null>;
}

export interface SettlementCheck {
  unknown: SettleUnknownRow;
  outcome: 'paid' | 'duplicate' | 'dead' | 'open' | 'unreachable';
  reason: string;
  /** Journal rows that record the outcome; none while it is open or the mirror is unreachable. */
  rows: ShopJournalRow[];
}

/**
 * True when the transaction paid the shop at least the payment's amount of its asset out of the
 * payer's account. "At least": an HBAR transfer list can also carry a staking reward credit.
 */
export function transferMatches(tx: MirrorTransaction, u: Pick<SettleUnknownRow, 'payer' | 'payTo' | 'amount' | 'asset'>): boolean {
  const moves = u.asset === HBAR_ASSET_ID ? tx.transfers : tx.tokenTransfers.filter((t) => t.tokenId === u.asset);
  const net = (account: string) => moves.filter((t) => t.account === account).reduce((s, t) => s + t.amount, 0n);
  return net(u.payTo) >= BigInt(u.amount) && net(u.payer) < 0n;
}

/**
 * What the mirror node says about every open `settle_unknown` row in `rows` (or only the order's),
 * with the rows that would record it. Reads only; the caller journals `rows`.
 */
export async function checkSettlements(deps: {
  rows: readonly ShopJournalRow[];
  mirror: MirrorTxReader;
  /** Unix seconds. */
  now: number;
  orderId?: string;
  at?: () => string;
}): Promise<SettlementCheck[]> {
  const at = deps.at ?? (() => new Date().toISOString());
  const book = new OrderBook();
  for (const row of deps.rows) book.apply(row);
  const out: SettlementCheck[] = [];
  for (const u of book.openSettlements(deps.orderId)) {
    let tx: MirrorTransaction | null;
    try {
      tx = await deps.mirror.transaction(u.txId);
    } catch (error) {
      out.push({ unknown: u, outcome: 'unreachable', reason: error instanceof Error ? error.message.slice(0, 200) : String(error), rows: [] });
      continue;
    }
    const resolved = (outcome: 'paid' | 'duplicate' | 'dead', reason: string): ShopJournalRow => ({
      type: 'settle_resolved',
      at: at(),
      orderId: u.orderId,
      txId: u.txId,
      outcome,
      reason,
    });
    let check: SettlementCheck;
    if (tx && tx.result === 'SUCCESS' && transferMatches(tx, u)) {
      const payment = { txId: u.txId, payer: u.payer, amount: u.amount, asset: u.asset, payTo: u.payTo };
      if (book.get(u.orderId)) {
        check = { unknown: u, outcome: 'duplicate', reason: 'the order was already paid', rows: [{ type: 'duplicate_payment', at: at(), orderId: u.orderId, ...payment }] };
      } else {
        const rows: ShopJournalRow[] = [
          { type: 'order_paid', at: at(), orderId: u.orderId, orderNonce: u.orderNonce, platform: u.platform, sku: u.sku, quantity: u.quantity, ...payment },
        ];
        // The payer passed the record-writer check before the payment was verified.
        if (u.refs) rows.push({ type: 'order_confirmed', at: at(), orderId: u.orderId, refs: u.refs });
        check = { unknown: u, outcome: 'paid', reason: `mirror ${tx.consensusTimestamp}`, rows };
      }
      check.rows.push(resolved(check.outcome as 'paid' | 'duplicate', check.reason));
    } else if (tx) {
      const reason = tx.result === 'SUCCESS' ? 'transfer_mismatch' : `transaction ${tx.result}`;
      check = { unknown: u, outcome: 'dead', reason, rows: [resolved('dead', reason)] };
    } else if (deps.now > validStartSeconds(u.txId) + SETTLE_DEAD_AFTER_S) {
      check = { unknown: u, outcome: 'dead', reason: 'expired unseen', rows: [resolved('dead', 'expired unseen')] };
    } else {
      check = { unknown: u, outcome: 'open', reason: 'not on the mirror node yet', rows: [] };
    }
    for (const row of check.rows) book.apply(row);
    out.push(check);
  }
  return out;
}
