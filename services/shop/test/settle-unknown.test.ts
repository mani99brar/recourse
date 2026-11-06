// A payment that lands on Hedera while the facilitator's settle reply errors or times out: the shop
// journals it as unknown, and the mirror node later decides whether it is the order.

import { afterEach, describe, expect, test } from 'vitest';
import { getAddress } from 'viem';
import { PrivateKey } from '@hiero-ledger/sdk';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { newOrderNonce, orderIdOf, type Parties } from '@recourse/shared';
import { mirrorTransactionId, readJournal, type MirrorTransaction } from '@recourse/records';
import { NONCE_HEADER, PLATFORM_HEADER, type ShopJournalRow } from '../src/app.js';
import { orderPath } from '../src/catalog.js';
import { fakeFacilitator, type FakeFacilitator } from './fake-facilitator.js';
import { TEST_SHOP_ACCOUNT, TEST_SHOP_ADDRESS, startTestShop } from './helpers.js';

const BUYER = '0.0.990200';
const PLATFORM = getAddress('0x00000000000000000000000000000000000000a1');
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const PARTIES: Parties = [
  { role: 'platform', evmAddress: PLATFORM, hederaAccountId: '0.0.990001', hcsWriters: [BUYER], displayName: 'Demo Agent Co' },
  { role: 'shop', evmAddress: TEST_SHOP_ADDRESS, hederaAccountId: TEST_SHOP_ACCOUNT, hcsWriters: [TEST_SHOP_ACCOUNT], displayName: 'Demo Shop' },
];

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** What the mirror node shows: the transfers the fake facilitator moved, by their Hedera id. */
function mirrorOf(fake: FakeFacilitator) {
  return {
    async transaction(txId: string): Promise<MirrorTransaction | null> {
      const s = fake.settled.find((x) => mirrorTransactionId(x.hederaTxId) === mirrorTransactionId(txId));
      if (!s) return null;
      const amount = BigInt(s.amount);
      return {
        transactionId: mirrorTransactionId(s.hederaTxId),
        result: 'SUCCESS',
        consensusTimestamp: '1800000000.000000001',
        name: 'CRYPTOTRANSFER',
        payer: s.hederaTxId.split('@')[0]!,
        transfers: [],
        tokenTransfers: [
          { tokenId: s.asset, account: s.payer, amount: -amount },
          { tokenId: s.asset, account: s.payTo, amount },
        ],
      };
    },
  };
}

function orderRequest() {
  const orderNonce = newOrderNonce();
  const orderId = orderIdOf(PLATFORM, TEST_SHOP_ADDRESS, orderNonce);
  return {
    orderId,
    headers: { 'content-type': 'application/json', [PLATFORM_HEADER]: PLATFORM, [NONCE_HEADER]: orderNonce },
    body: { orderId, refs: { asked: { seq: '1', hash: H(1) }, shown: { seq: '2', hash: H(2) }, approval: { seq: '3', hash: H(3) } } },
  };
}

async function payOrder(url: string, req: ReturnType<typeof orderRequest>) {
  const client = new x402Client().register('hedera:testnet', new ExactHederaScheme(createClientHederaSigner(BUYER, PrivateKey.generateECDSA(), { network: 'hedera:testnet' })));
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: true });
  const http = new x402HTTPClient(client);
  const body = JSON.stringify(req.body);
  const first = await fetch(url, { method: 'POST', headers: req.headers, body });
  if (first.status !== 402) return { first, second: null };
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
  const payload = await http.createPaymentPayload(required);
  const second = await fetch(url, { method: 'POST', headers: { ...req.headers, ...http.encodePaymentSignatureHeader(payload) }, body });
  return { first, second };
}

const rowsOf = (dir: string) => readJournal<ShopJournalRow>(`${dir}/journal.jsonl`).rows;

describe('a settle the shop never heard back about', () => {
  test('lands, times out at the facilitator, and becomes the order once the mirror node shows it', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake], {}, { parties: PARTIES, mirror: mirrorOf(fake) });
    cleanup = shop.close;
    const req = orderRequest();
    const url = `${shop.url}${orderPath('cap-red', 1)}`;
    fake.faults = ['land_then_timeout'];
    const { second } = await payOrder(url, req);
    expect(second!.status).toBe(402);
    expect(fake.settled).toHaveLength(1);
    const hederaTxId = fake.settled[0]!.hederaTxId;
    expect(rowsOf(shop.config.stateDir).find((r) => r.type === 'settle_unknown')).toMatchObject({ orderId: req.orderId, txId: hederaTxId, payer: BUYER, amount: '1000000' });

    const view = await fetch(`${shop.url}/orders/${req.orderId}`);
    expect(view.status).toBe(200);
    const { order } = (await view.json()) as { order: { status: string; payment: { txId: string }; refs: unknown } };
    expect(order).toMatchObject({ status: 'paid', payment: { txId: hederaTxId }, refs: req.body.refs });
    expect(rowsOf(shop.config.stateDir).map((r) => r.type)).toEqual(['settle_unknown', 'order_paid', 'order_confirmed', 'settle_resolved']);

    // A retried payment for the same order is refused before anything is signed.
    const again = await payOrder(url, req);
    expect(again.first.status).toBe(409);
    expect(((await again.first.json()) as { error: string }).error).toBe('order_exists');
    expect(fake.settled).toHaveLength(1);
  });

  test('is reconciled at boot from the journal alone', async () => {
    const fake = fakeFacilitator();
    const first = await startTestShop([fake], {}, { parties: PARTIES });
    const req = orderRequest();
    fake.faults = ['land_then_timeout'];
    expect((await payOrder(`${first.url}${orderPath('cap-red', 1)}`, req)).second!.status).toBe(402);
    const stateDir = first.config.stateDir;
    await first.close();
    const second = await startTestShop([fake], { stateDir }, { parties: PARTIES, mirror: mirrorOf(fake) });
    cleanup = second.close;
    expect(second.shop.book.get(req.orderId)).toBeUndefined();
    await second.shop.reconcile();
    expect(second.shop.book.get(req.orderId)).toMatchObject({ status: 'paid', payment: { txId: fake.settled[0]!.hederaTxId } });
  });

  test('that never landed holds the order until its validity window has passed, then lets it be paid again', async () => {
    const fake = fakeFacilitator();
    let clock = Math.floor(Date.now() / 1000);
    const shop = await startTestShop([fake], {}, { parties: PARTIES, mirror: mirrorOf(fake), now: () => clock });
    cleanup = shop.close;
    const req = orderRequest();
    const url = `${shop.url}${orderPath('cap-red', 1)}`;
    fake.faults = ['timeout'];
    expect((await payOrder(url, req)).second!.status).toBe(402);
    expect(fake.settled).toHaveLength(0);
    expect(rowsOf(shop.config.stateDir).map((r) => r.type)).toEqual(['settle_unknown']);

    expect((await fetch(`${shop.url}/orders/${req.orderId}`)).status).toBe(404);
    const held = await payOrder(url, req);
    expect(held.first.status).toBe(409);
    expect(((await held.first.json()) as { error: string }).error).toBe('order_settle_pending');

    clock += 400;
    expect((await fetch(`${shop.url}/orders/${req.orderId}`)).status).toBe(404);
    expect(rowsOf(shop.config.stateDir).at(-1)).toMatchObject({ type: 'settle_resolved', outcome: 'dead', reason: 'expired unseen' });
    expect((await payOrder(url, req)).second!.status).toBe(200);
    expect(fake.settled).toHaveLength(1);
  });
});
