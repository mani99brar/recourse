import { afterEach, describe, expect, test } from 'vitest';
import { getAddress } from 'viem';
import { PrivateKey } from '@hiero-ledger/sdk';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { encodeRecordMsg, newOrderNonce, orderIdOf, type Parties } from '@recourse/shared';
import { MemoryLedger, TopicReader, cidOfHash, readJournal } from '@recourse/records';
import { NONCE_HEADER, PLATFORM_HEADER, type ShopJournalRow } from '../src/app.js';
import { CATALOG, MAX_QUANTITY, orderPath } from '../src/catalog.js';
import { fakeFacilitator } from './fake-facilitator.js';
import { TEST_SHOP_ACCOUNT, TEST_SHOP_ADDRESS, startTestShop } from './helpers.js';

const BUYER = '0.0.990200';
const PLATFORM = getAddress('0x00000000000000000000000000000000000000a1');
const STRANGER = getAddress('0x00000000000000000000000000000000000000c3');
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

function buyer(account = BUYER) {
  const signer = createClientHederaSigner(account, PrivateKey.generateECDSA(), { network: 'hedera:testnet' });
  const client = new x402Client().register('hedera:testnet', new ExactHederaScheme(signer));
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: true });
  return new x402HTTPClient(client);
}

function orderRequest(orderNonce: string, platform: string = PLATFORM) {
  const orderId = orderIdOf(platform as `0x${string}`, TEST_SHOP_ADDRESS, orderNonce as `0x${string}`);
  return {
    orderId,
    headers: { 'content-type': 'application/json', [PLATFORM_HEADER]: platform, [NONCE_HEADER]: orderNonce },
    body: { orderId, refs: { asked: { seq: '1', hash: H(1) }, shown: { seq: '2', hash: H(2) }, approval: { seq: '3', hash: H(3) } } },
  };
}

async function payOrder(url: string, req: ReturnType<typeof orderRequest>, options: { account?: string; body?: unknown } = {}) {
  const http = buyer(options.account);
  const body = JSON.stringify(options.body ?? req.body);
  const first = await fetch(url, { method: 'POST', headers: req.headers, body });
  if (first.status !== 402) return { first, second: null };
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
  const payload = await http.createPaymentPayload(required);
  const second = await fetch(url, { method: 'POST', headers: { ...req.headers, ...http.encodePaymentSignatureHeader(payload) }, body });
  return { first, second, required };
}

describe('catalogue and prices', () => {
  test('lists every item and quantity, and each route asks for the basket total', async () => {
    const shop = await startTestShop([fakeFacilitator()]);
    cleanup = shop.close;
    const catalog = (await (await fetch(`${shop.url}/catalog`)).json()) as { items: { sku: string; quantities: unknown[] }[] };
    expect(catalog.items.map((i) => i.sku)).toEqual(CATALOG.map((i) => i.sku));
    expect(catalog.items.every((i) => i.quantities.length === MAX_QUANTITY)).toBe(true);
    const { first, required } = await payOrder(`${shop.url}${orderPath('tee-navy-m', 2)}`, orderRequest(newOrderNonce()));
    expect(first.status).toBe(402);
    expect(required!.accepts[0]).toMatchObject({ amount: '3000000', payTo: TEST_SHOP_ACCOUNT });
  });
});

describe('order gate', () => {
  test('refuses before any payment is verified or settled', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake], {}, { parties: PARTIES });
    cleanup = shop.close;
    const url = `${shop.url}${orderPath('cap-red', 1)}`;
    const ok = orderRequest(newOrderNonce());

    const noHeaders = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noHeaders.status).toBe(400);
    expect((await noHeaders.json()).error).toBe('bad_order_headers');

    expect((await fetch(`${shop.url}/x402/orders/cap-blue/1`, { method: 'POST', headers: ok.headers, body: '{}' })).status).toBe(404);
    expect((await fetch(`${shop.url}${orderPath('cap-red', 1).replace(/1$/, '4')}`, { method: 'POST', headers: ok.headers, body: '{}' })).status).toBe(404);

    const stranger = await payOrder(url, orderRequest(newOrderNonce(), STRANGER));
    expect(stranger.first.status).toBe(403);
    expect((await stranger.first.json()).error).toBe('unknown_platform');

    const badBody = await payOrder(url, ok, { body: { orderId: ok.orderId } });
    expect(badBody.second!.status).toBe(400);
    expect((await badBody.second!.json()).error).toBe('bad_order_body');

    const otherId = await payOrder(url, ok, { body: { ...ok.body, orderId: H(9) } });
    expect(otherId.second!.status).toBe(400);
    expect((await otherId.second!.json()).error).toBe('order_id_mismatch');

    const wrongPayer = await payOrder(url, ok, { account: '0.0.990299' });
    expect(wrongPayer.second!.status).not.toBe(200);
    expect(JSON.stringify(await wrongPayer.second!.json().catch(() => ({})))).not.toContain('"ok":true');

    expect(fake.calls.settle).toBe(0);
    expect(fake.settled).toHaveLength(0);
  });

  test('checks the platform standing when the check is on', async () => {
    let answer: boolean | Error = false;
    let exitRequestedAt = 0n;
    const standing = {
      inGoodStanding: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
      exitRequestedAt: async () => exitRequestedAt,
    };
    const shop = await startTestShop([fakeFacilitator()], { standingCheck: 'vault' }, { parties: PARTIES, standing });
    cleanup = shop.close;
    const url = `${shop.url}${orderPath('cap-red', 1)}`;
    const send = () => fetch(url, { method: 'POST', headers: orderRequest(newOrderNonce()).headers, body: '{}' });
    const refused = await send();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe('platform_not_in_good_standing');
    answer = new Error('relay down');
    const unreadable = await send();
    expect(unreadable.status).toBe(503);
    expect((await unreadable.json()).error).toBe('standing_unreadable');
    answer = true;
    expect((await send()).status).toBe(402);
    // A platform that asked to leave the vault is not sold to, though still in good standing.
    exitRequestedAt = 1_800_000_000n;
    const leaving = await send();
    expect(leaving.status).toBe(403);
    expect((await leaving.json()).error).toBe('platform_exit_requested');
  });
});

describe('paid orders', () => {
  test('journals the payment before the reply, confirms the refs and refuses a second order with the same id', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake], {}, { parties: PARTIES });
    cleanup = shop.close;
    const req = orderRequest(newOrderNonce());
    const url = `${shop.url}${orderPath('tee-navy-l', 3)}`;
    const { second } = await payOrder(url, req);
    expect(second!.status).toBe(200);
    const reply = (await second!.json()) as { orderId: string; txId: string; amount: string; payer: string };
    expect(reply).toMatchObject({ orderId: req.orderId, amount: '4500000', payer: BUYER });
    expect(reply.txId).toMatch(/^fake-settlement:/);
    expect(fake.settled).toHaveLength(1);

    const rows = readJournal<ShopJournalRow>(`${shop.config.stateDir}/journal.jsonl`).rows;
    expect(rows.map((r) => r.type)).toEqual(['order_paid', 'order_confirmed']);
    const view = (await (await fetch(`${shop.url}/orders/${req.orderId}`)).json()) as { order: { status: string; refs: unknown } };
    expect(view.order.status).toBe('paid');
    expect(view.order.refs).toEqual(req.body.refs);

    const again = await payOrder(url, req);
    expect(again.first.status).toBe(409);
    expect((await again.first.json()).error).toBe('order_exists');
    expect(fake.settled).toHaveLength(1);
  });

  test('keeps orders across a restart', async () => {
    const fake = fakeFacilitator();
    const first = await startTestShop([fake], {}, { parties: PARTIES });
    const req = orderRequest(newOrderNonce());
    const url = (base: string) => `${base}${orderPath('cap-red', 1)}`;
    expect((await payOrder(url(first.url), req)).second!.status).toBe(200);
    const stateDir = first.config.stateDir;
    await first.close();
    const second = await startTestShop([fake], { stateDir }, { parties: PARTIES });
    cleanup = second.close;
    expect(((await (await fetch(`${second.url}/orders/${req.orderId}`)).json()) as { order: { status: string } }).order.status).toBe('paid');
    expect((await payOrder(url(second.url), req)).first.status).toBe(409);
    expect(fake.settled).toHaveLength(1);
  });

  test('accepts a complaint only when it points at the agent\'s arrived record on the topic', async () => {
    const ledger = new MemoryLedger();
    const topic = '0.0.7000001';
    ledger.createTopic(topic);
    const reader = new TopicReader(ledger.mirror(), topic);
    const shop = await startTestShop([fakeFacilitator()], {}, { parties: PARTIES, reader });
    cleanup = shop.close;
    const req = orderRequest(newOrderNonce());
    expect((await payOrder(`${shop.url}${orderPath('cap-red', 1)}`, req)).second!.status).toBe(200);
    const hash = H(55);
    const cid = cidOfHash(hash).toString();
    const seq = ledger.append(topic, BUYER, encodeRecordMsg({ cid, hash, kind: 5, orderId: req.orderId }));
    const complain = (body: unknown) =>
      fetch(`${shop.url}/orders/${req.orderId}/complaint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const wrong = await complain({ orderId: req.orderId, seq: String(seq), hash: H(56), cid });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe('complaint_not_on_topic');
    expect((await complain({ orderId: req.orderId, seq: String(seq), hash, cid, note: 'free text' })).status).toBe(400);
    const ok = await complain({ orderId: req.orderId, seq: String(seq), hash, cid });
    expect(ok.status).toBe(200);
    const view = (await (await fetch(`${shop.url}/orders/${req.orderId}`)).json()) as { order: { complaint: unknown } };
    expect(view.order.complaint).toEqual({ seq: String(seq), hash, cid });
  });
});
