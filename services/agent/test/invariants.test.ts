// Crash anywhere in the buy flow, restart, and check the money and the records: every order is
// settled exactly once, each of its records is on the topic exactly once, and its ordered record
// carries the settled transaction id. Two orders of the same item and price run back to back.
// The facilitator fails too: down, unable to submit, or landing the transfer and then timing out,
// so the shop only learns of the payment from the mirror node.

import { describe, expect, test } from 'vitest';
import { RecordKind, decodeRecordMsg } from '@recourse/shared';
import { readJournal, type SendFault } from '@recourse/records';
import type { ShopJournalRow } from '../../shop/src/orders.js';
import type { FakeMode } from '../../shop/test/fake-facilitator.js';
import { AGENT, ASKED_CAP, TOPIC, docAt, world } from './world.js';

type FetchFault = 'ok' | 'drop_before' | 'lost_reply' | 'hang_before' | 'hang_after';
const FETCH_FAULTS: FetchFault[] = ['ok', 'drop_before', 'lost_reply', 'hang_before', 'hang_after'];
const SEND_FAULTS: SendFault[] = ['ok', 'drop', 'lost_reply', 'hang', 'land_and_hang'];
const SETTLE_FAULTS: FakeMode[] = ['ok', 'land_then_timeout', 'land_then_timeout', 'timeout', 'submit_failed'];

function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
}

function faultyFetch(faults: FetchFault[], kill: () => void): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const paying = req.url.includes('/x402/orders/') && (req.headers.has('payment-signature') || req.headers.has('x-payment'));
    if (!paying) return fetch(req);
    const fault = faults.shift() ?? 'ok';
    if (fault === 'drop_before') throw new TypeError('fetch failed (simulated)');
    if (fault === 'hang_before') {
      kill();
      return new Promise<never>(() => {});
    }
    const res = await fetch(req);
    if (fault === 'lost_reply') throw new TypeError('fetch failed (simulated lost reply)');
    if (fault === 'hang_after') {
      kill();
      return new Promise<never>(() => {});
    }
    return res;
  };
}

describe('buy flow invariants', () => {
  test('no order is paid twice and no record is written twice over 100 random crash sequences', async () => {
    const w = await world({ limits: { dailyCap: 10_000_000_000n } });
    try {
      const orders: `0x${string}`[] = [];
      const expired: `0x${string}`[] = [];
      for (let seed = 1; seed <= 100; seed++) {
        const rand = prng(seed);
        const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
        for (let n = 0; n < 2; n++) {
          const draftOpen = w.open();
          const orderId = draftOpen.buyer.draft({ sku: 'cap-red', quantity: 1, asked: ASKED_CAP });
          orders.push(orderId);
          let done = false;
          for (let life = 0; life < 16 && !done; life++) {
            const calm = life >= 8;
            let kill!: () => void;
            const killed = new Promise<'killed'>((resolve) => {
              kill = () => resolve('killed');
            });
            const fetchFaults = calm ? [] : Array.from({ length: Math.floor(rand() * 3) }, () => pick(FETCH_FAULTS));
            const sendFaults = calm ? [] : Array.from({ length: Math.floor(rand() * 3) }, () => pick(SEND_FAULTS));
            w.fake.faults = calm ? [] : Array.from({ length: Math.floor(rand() * 2) }, () => pick(SETTLE_FAULTS));
            const { buyer, submitter } = w.open({
              fetchImpl: faultyFetch(fetchFaults, () => kill()),
              submitter: { faults: sendFaults, receipts: rand() < 0.5 },
            });
            const outcome = await Promise.race([buyer.run(orderId), killed, submitter.hung.then(() => 'killed' as const)]);
            if (outcome !== 'killed') {
              // An approval can run out while a dead payment waits out its validity window; the
              // order then ends unpaid.
              expect(['done', 'expired'], `seed ${seed} order ${n}: ${JSON.stringify(outcome)}`).toContain(outcome.state);
              if (outcome.state === 'expired') {
                expired.push(orderId);
                orders.pop();
              }
              done = true;
            }
            w.ledger.clock += Math.floor(rand() * 300);
          }
          expect(done, `seed ${seed} order ${n}`).toBe(true);
        }
      }

      const shopRows = readJournal<ShopJournalRow>(`${w.shop.config.stateDir}/journal.jsonl`).rows;
      const paidRows = shopRows.filter((r): r is Extract<ShopJournalRow, { type: 'order_paid' }> => r.type === 'order_paid');
      expect(w.fake.settled).toHaveLength(orders.length);
      expect(paidRows).toHaveLength(orders.length);
      const messages = w.ledger.messages(TOPIC).map((m) => ({ payer: m.payer, d: decodeRecordMsg(m.bytes) }));
      for (const orderId of orders) {
        const paid = paidRows.filter((r) => r.orderId === orderId);
        expect(paid, orderId).toHaveLength(1);
        for (const kind of [RecordKind.Asked, RecordKind.Shown, RecordKind.Approval, RecordKind.Ordered]) {
          const own = messages.filter((m) => m.payer === AGENT && m.d.ok && m.d.value.orderId === orderId && m.d.value.kind === kind);
          expect(own, `${orderId} kind ${kind}`).toHaveLength(1);
        }
        const o = messages.find((m) => m.d.ok && m.d.value.orderId === orderId && m.d.value.kind === RecordKind.Ordered)!;
        const doc = await docAt(w, (o.d as { ok: true; value: { cid: string } }).value.cid);
        expect(doc.x402TxId, orderId).toBe(paid[0]!.txId);
      }
      for (const orderId of expired) {
        expect(paidRows.filter((r) => r.orderId === orderId), orderId).toHaveLength(0);
        const o = messages.filter((m) => m.d.ok && m.d.value.orderId === orderId && m.d.value.kind === RecordKind.Ordered);
        expect(o, orderId).toHaveLength(0);
      }
      expect(orders.length).toBeGreaterThan(150);
      // Two orders in a row at the same price never share a settlement.
      expect(new Set(paidRows.map((r) => r.txId)).size).toBe(orders.length);
      // Transfers the shop only learned of from the mirror node are orders like any other.
      const landed = w.fake.settled.filter((s) => s.landed);
      expect(landed.length).toBeGreaterThan(10);
      for (const s of landed) expect(paidRows.filter((r) => r.txId === s.txId), s.txId).toHaveLength(1);
      expect(shopRows.filter((r) => r.type === 'duplicate_payment')).toHaveLength(0);
    } finally {
      await w.close();
    }
  }, 600_000);
});
