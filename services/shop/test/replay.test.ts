// One signed transfer pays for one thing. A platform that sends a payment the shop already took
// again, for a new order, is refused before the payment is verified; and a settle of unknown outcome
// whose transfer the journal already credits resolves as dead, whatever the mirror node says.
//
// The fake facilitator answers with bare Hedera ids here (`bareIds`), as a real one does, so the
// id journaled for the first order and the id signed into the replayed payment are the same string.

import { afterEach, describe, expect, test } from 'vitest';
import { getAddress } from 'viem';
import { PrivateKey } from '@hiero-ledger/sdk';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { newOrderNonce, orderIdOf, type Parties } from '@recourse/shared';
import { Journal, mirrorTransactionId, readJournal, type MirrorTransaction } from '@recourse/records';
import { NONCE_HEADER, PING_ROUTE, PLATFORM_HEADER, type ShopJournalRow } from '../src/app.js';
import { orderPath } from '../src/catalog.js';
import { HBAR_ASSET_ID, USDC_TOKEN_ID } from '../src/payments.js';
import { checkSettlements } from '../src/reconcile.js';
import { fakeFacilitator, type FakeFacilitator } from './fake-facilitator.js';
import { TEST_SHOP_ACCOUNT, TEST_SHOP_ADDRESS, startTestShop, testConfig } from './helpers.js';

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

/** A mirror node that shows a successful transfer of `amount` of `asset` from the buyer to the shop. */
function successfulTransfer(txId: string, amount: bigint, asset: string): MirrorTransaction {
  const moves = [
    { account: BUYER, amount: -amount },
    { account: TEST_SHOP_ACCOUNT, amount },
  ];
  return {
    transactionId: mirrorTransactionId(txId),
    result: 'SUCCESS',
    consensusTimestamp: '1800000000.000000001',
    name: 'CRYPTOTRANSFER',
    payer: txId.split('@')[0]!,
    transfers: asset === HBAR_ASSET_ID ? [...moves, { account: '0.0.990001', amount: -1000n }, { account: '0.0.98', amount: 1000n }] : [],
    tokenTransfers: asset === HBAR_ASSET_ID ? [] : moves.map((m) => ({ tokenId: asset, ...m })),
  };
}

/** What the mirror node shows: the transfers the fake facilitator moved, by their Hedera id. */
function mirrorOf(fake: FakeFacilitator) {
  return {
    async transaction(txId: string): Promise<MirrorTransaction | null> {
      const s = fake.settled.find((x) => mirrorTransactionId(x.hederaTxId) === mirrorTransactionId(txId));
      return s ? successfulTransfer(s.hederaTxId, BigInt(s.amount), s.asset) : null;
    },
  };
}

function orderRequest() {
  const orderNonce = newOrderNonce();
  const orderId = orderIdOf(PLATFORM, TEST_SHOP_ADDRESS, orderNonce);
  return {
    orderId,
    headers: { 'content-type': 'application/json', [PLATFORM_HEADER]: PLATFORM, [NONCE_HEADER]: orderNonce },
    body: JSON.stringify({ orderId, refs: { asked: { seq: '1', hash: H(1) }, shown: { seq: '2', hash: H(2) }, approval: { seq: '3', hash: H(3) } } }),
  };
}

/** Probes `url` with the request and signs a payment for the 402 it gets; sends nothing paid. */
async function signFor(url: string, init: { headers: Record<string, string>; body: string }) {
  const client = new x402Client().register('hedera:testnet', new ExactHederaScheme(createClientHederaSigner(BUYER, PrivateKey.generateECDSA(), { network: 'hedera:testnet' })));
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: true });
  const http = new x402HTTPClient(client);
  const probe = await fetch(url, { method: 'POST', ...init });
  expect(probe.status).toBe(402);
  const payload = await http.createPaymentPayload(http.getPaymentRequiredResponse((n) => probe.headers.get(n), await probe.json().catch(() => undefined)));
  return http.encodePaymentSignatureHeader(payload);
}

const rowsOf = (dir: string) => readJournal<ShopJournalRow>(`${dir}/journal.jsonl`).rows;

describe('a payment sent again for another order', () => {
  test.each(['usdc', 'hbar'] as const)('is refused before it is verified and pays for nothing (%s)', async (priceAsset) => {
    const fake = fakeFacilitator();
    fake.bareIds = true;
    const mirror = mirrorOf(fake);
    const shop = await startTestShop([fake], { priceAsset }, { parties: PARTIES, mirror });
    cleanup = shop.close;
    const url = `${shop.url}${orderPath('cap-red', 1)}`;

    const a = orderRequest();
    const header = await signFor(url, a);
    const paidA = await fetch(url, { method: 'POST', headers: { ...a.headers, ...header }, body: a.body });
    expect(paidA.status).toBe(200);
    expect(fake.settled).toHaveLength(1);
    const txId = fake.settled[0]!.hederaTxId;
    expect(rowsOf(shop.config.stateDir).find((r) => r.type === 'order_paid')).toMatchObject({ orderId: a.orderId, txId });

    // The network would refuse the same transaction at submit as a duplicate.
    fake.mode = 'submit_failed';
    const calls = { ...fake.calls };
    const replays: string[] = [];
    for (let i = 0; i < 3; i++) {
      const b = orderRequest();
      replays.push(b.orderId);
      const replay = await fetch(url, { method: 'POST', headers: { ...b.headers, ...header }, body: b.body });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({ error: 'payment_already_used', txId });
      // Asking for the order neither finds it nor credits the first order's transfer to it.
      const view = await fetch(`${shop.url}/orders/${b.orderId}`);
      expect(view.status).toBe(404);
      expect(await view.json()).toEqual({ error: 'order_not_found' });
    }
    expect(fake.calls.verify).toBe(calls.verify);
    expect(fake.calls.settle).toBe(calls.settle);
    expect(fake.settled).toHaveLength(1);
    expect(rowsOf(shop.config.stateDir).map((r) => r.type)).toEqual(['order_paid', 'order_confirmed']);
    for (const orderId of replays) expect(shop.shop.book.get(orderId)).toBeUndefined();
    // Three replays are not three facilitator failures: the shop stays on its rung.
    expect(shop.ladder.state()).toMatchObject({ rung: 1, consecutiveFailures: 0 });
    expect(shop.log.lines.filter((e) => e.event === 'payment_reused' && e.level === 'error')).toHaveLength(3);
  });

  test('is refused while the first request is still settling it', async () => {
    const fake = fakeFacilitator();
    fake.bareIds = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inSettle = new Promise<void>((r) => (entered = r));
    let settles = 0;
    const slow: FakeFacilitator = {
      ...fake,
      settle: async (payload, requirements) => {
        settles += 1;
        if (settles === 1) {
          entered();
          await gate;
          return fake.settle(payload, requirements);
        }
        // What the network answers for a transaction id it has already taken.
        return { success: false, errorReason: 'transaction_failed', errorMessage: 'DUPLICATE_TRANSACTION', transaction: '', network: requirements.network, payer: BUYER };
      },
    };
    const shop = await startTestShop([slow], {}, { parties: PARTIES, mirror: mirrorOf(fake) });
    cleanup = shop.close;
    const url = `${shop.url}${orderPath('cap-red', 1)}`;
    const a = orderRequest();
    const header = await signFor(url, a);
    const paidA = fetch(url, { method: 'POST', headers: { ...a.headers, ...header }, body: a.body });
    await inSettle;

    const b = orderRequest();
    const during = await fetch(url, { method: 'POST', headers: { ...b.headers, ...header }, body: b.body });
    expect(during.status).toBe(409);
    expect(((await during.json()) as { error: string }).error).toBe('payment_in_flight');
    expect(settles).toBe(1);

    release();
    expect((await paidA).status).toBe(200);
    const after = await fetch(url, { method: 'POST', headers: { ...b.headers, ...header }, body: b.body });
    expect(after.status).toBe(409);
    expect(((await after.json()) as { error: string }).error).toBe('payment_already_used');
    expect(settles).toBe(1);
    expect(rowsOf(shop.config.stateDir).map((r) => r.type)).toEqual(['order_paid', 'order_confirmed']);
    expect((await fetch(`${shop.url}/orders/${b.orderId}`)).status).toBe(404);
    expect(shop.ladder.state().consecutiveFailures).toBe(0);
  });

  test('is refused while the first order still waits on the mirror node, which then pays the first order', async () => {
    const fake = fakeFacilitator();
    fake.bareIds = true;
    const shop = await startTestShop([fake], {}, { parties: PARTIES, mirror: mirrorOf(fake) });
    cleanup = shop.close;
    const url = `${shop.url}${orderPath('cap-red', 1)}`;
    const a = orderRequest();
    const header = await signFor(url, a);
    fake.faults = ['land_then_timeout'];
    expect((await fetch(url, { method: 'POST', headers: { ...a.headers, ...header }, body: a.body })).status).toBe(402);
    const txId = fake.settled[0]!.hederaTxId;
    expect(rowsOf(shop.config.stateDir).map((r) => r.type)).toEqual(['settle_unknown']);

    fake.mode = 'submit_failed';
    const b = orderRequest();
    const replay = await fetch(url, { method: 'POST', headers: { ...b.headers, ...header }, body: b.body });
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { error: string }).error).toBe('payment_already_used');
    expect((await fetch(`${shop.url}/orders/${b.orderId}`)).status).toBe(404);

    const viewA = await fetch(`${shop.url}/orders/${a.orderId}`);
    expect(viewA.status).toBe(200);
    expect(((await viewA.json()) as { order: { status: string; payment: { txId: string } } }).order).toMatchObject({ status: 'paid', payment: { txId } });
    expect(rowsOf(shop.config.stateDir).filter((r) => r.type === 'order_paid').map((r) => (r as { orderId: string }).orderId)).toEqual([a.orderId]);
  });

  test('a connectivity check paid once cannot be paid with again', async () => {
    const fake = fakeFacilitator();
    fake.bareIds = true;
    const shop = await startTestShop([fake], {}, { parties: PARTIES });
    cleanup = shop.close;
    const url = `${shop.url}${PING_ROUTE}`;
    const init = { headers: { 'content-type': 'application/json' }, body: '{}' };
    const header = await signFor(url, init);
    expect((await fetch(url, { method: 'POST', headers: { ...init.headers, ...header }, body: init.body })).status).toBe(200);
    fake.mode = 'submit_failed';
    for (let i = 0; i < 3; i++) {
      const again = await fetch(url, { method: 'POST', headers: { ...init.headers, ...header }, body: init.body });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe('payment_already_used');
    }
    expect(fake.calls.settle).toBe(1);
    expect(shop.ladder.state()).toMatchObject({ rung: 1, consecutiveFailures: 0 });
  });
});

describe('a settle of unknown outcome whose transfer the journal already credits', () => {
  const T = '0.0.990001@1800000000.000000005';
  const paidRow = (orderId: `0x${string}`, txId: string): ShopJournalRow => ({
    type: 'order_paid',
    at: '2026-01-01T00:00:00.000Z',
    orderId,
    orderNonce: H(100),
    platform: PLATFORM,
    sku: 'cap-red',
    quantity: 1,
    txId,
    payer: BUYER,
    amount: '1000000',
    asset: USDC_TOKEN_ID,
    payTo: TEST_SHOP_ACCOUNT,
  });
  const unknownRow = (orderId: `0x${string}`, txId: string): ShopJournalRow => ({
    type: 'settle_unknown',
    at: '2026-01-01T00:00:10.000Z',
    orderId,
    orderNonce: H(101),
    platform: PLATFORM,
    sku: 'cap-red',
    quantity: 1,
    txId,
    payer: BUYER,
    amount: '1000000',
    asset: USDC_TOKEN_ID,
    payTo: TEST_SHOP_ACCOUNT,
    reason: 'transaction_failed',
    refs: { asked: { seq: '1', hash: H(1) }, shown: { seq: '2', hash: H(2) }, approval: { seq: '3', hash: H(3) } },
  });
  const succeeded = { transaction: async (txId: string) => successfulTransfer(txId, 1_000_000n, USDC_TOKEN_ID) };

  test.each([
    ['the same spelling', T],
    ["the mirror node's spelling", '0.0.990001-1800000000-000000005'],
  ])('is dead even when the mirror shows the transfer succeeded (first order journaled in %s)', async (_label, firstTxId) => {
    const rows = [paidRow(H(7), firstTxId), unknownRow(H(9), '0.0.990001@1800000000.5')];
    const [check] = await checkSettlements({ rows, mirror: succeeded, now: 1_800_000_010, at: () => '2026-01-01T00:01:00.000Z' });
    expect(check).toMatchObject({ outcome: 'reused', reason: `tx_already_used: order ${H(7)}` });
    expect(check!.rows).toEqual([
      { type: 'settle_resolved', at: '2026-01-01T00:01:00.000Z', orderId: H(9), txId: '0.0.990001@1800000000.5', outcome: 'dead', reason: `tx_already_used: order ${H(7)}` },
    ]);
  });

  test('journaled before this check existed, resolves as dead at boot and on a read of the order', async () => {
    const config = testConfig();
    const journal = Journal.open<ShopJournalRow>(`${config.stateDir}/journal.jsonl`);
    journal.append(paidRow(H(7), T));
    journal.append({ type: 'order_confirmed', at: '2026-01-01T00:00:01.000Z', orderId: H(7), refs: { asked: { seq: '1', hash: H(1) }, shown: { seq: '2', hash: H(2) }, approval: { seq: '3', hash: H(3) } } });
    journal.append(unknownRow(H(9), T));
    journal.close();

    const shop = await startTestShop([fakeFacilitator()], { stateDir: config.stateDir }, { parties: PARTIES, mirror: succeeded, now: () => 1_800_000_010 });
    cleanup = shop.close;
    const view = await fetch(`${shop.url}/orders/${H(9)}`);
    expect(view.status).toBe(404);
    expect(await view.json()).toEqual({ error: 'order_not_found' });
    expect(rowsOf(config.stateDir).at(-1)).toMatchObject({ type: 'settle_resolved', orderId: H(9), outcome: 'dead', reason: `tx_already_used: order ${H(7)}` });
    expect(shop.shop.book.get(H(9))).toBeUndefined();
    expect(shop.shop.book.get(H(7))).toMatchObject({ status: 'paid', payment: { txId: T } });
    await shop.shop.reconcile();
    expect(rowsOf(config.stateDir).filter((r) => r.type === 'settle_resolved')).toHaveLength(1);
  });
});
