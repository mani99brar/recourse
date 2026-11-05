import { afterEach, describe, expect, test } from 'vitest';
import { PrivateKey } from '@hiero-ledger/sdk';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { PING_PRICE_USDC, PING_ROUTE } from '../src/app.js';
import { USDC_TOKEN_ID } from '../src/payments.js';
import { FAKE_FEE_PAYER, fakeFacilitator } from './fake-facilitator.js';
import { TEST_SHOP_ACCOUNT, startTestShop } from './helpers.js';

const BUYER = '0.0.990200';
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function buyer() {
  const signer = createClientHederaSigner(BUYER, PrivateKey.generateECDSA(), { network: 'hedera:testnet' });
  const client = new x402Client().register('hedera:testnet', new ExactHederaScheme(signer));
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: true });
  return new x402HTTPClient(client);
}

async function pay(url: string) {
  const http = buyer();
  const first = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(first.status).toBe(402);
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
  const payload = await http.createPaymentPayload(required);
  const second = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...http.encodePaymentSignatureHeader(payload) },
    body: '{}',
  });
  return { required, second, http };
}

describe('connectivity-check route', () => {
  test('402 names the price, asset, network, payTo, fee payer and the upfront flow', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake]);
    cleanup = shop.close;
    const res = await fetch(`${shop.url}${PING_ROUTE}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(402);
    const http = buyer();
    const required = http.getPaymentRequiredResponse((n) => res.headers.get(n), await res.json().catch(() => undefined));
    expect(required.accepts).toHaveLength(1);
    const r = required.accepts[0]!;
    expect(r).toMatchObject({
      scheme: 'exact',
      network: 'hedera:testnet',
      asset: USDC_TOKEN_ID,
      amount: PING_PRICE_USDC,
      payTo: TEST_SHOP_ACCOUNT,
    });
    expect(r.extra.feePayer).toBe(FAKE_FEE_PAYER);
    expect(r.extra.paymentFlow).toBe('upfront');
    expect(fake.calls.settle).toBe(0);
  });

  test('a paid request settles before the handler and is journaled with the tx id', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake]);
    cleanup = shop.close;
    const { second, http } = await pay(`${shop.url}${PING_ROUTE}`);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { txId: string; payer: string; amount: string };
    expect(fake.settled).toHaveLength(1);
    expect(body.txId).toBe(fake.settled[0]!.txId);
    expect(body.payer).toBe(BUYER);
    expect(body.amount).toBe(PING_PRICE_USDC);
    const settle = http.getPaymentSettleResponse((n) => second.headers.get(n));
    expect(settle.success).toBe(true);
    expect(settle.transaction).toBe(body.txId);
    const rows = shop.journal.rows();
    expect(rows.map((r) => r.type)).toEqual(['settled', 'ping_paid']);
    expect(rows[0]).toMatchObject({ txId: body.txId, payer: BUYER, amount: PING_PRICE_USDC, payTo: TEST_SHOP_ACCOUNT });
  });

  test('a rejected settlement never reaches the handler', async () => {
    const fake = fakeFacilitator();
    fake.mode = 'reject';
    const shop = await startTestShop([fake]);
    cleanup = shop.close;
    const { second } = await pay(`${shop.url}${PING_ROUTE}`);
    expect(second.status).toBe(402);
    expect(shop.journal.rows()).toEqual([]);
  });

  test('HBAR pricing uses the HBAR asset and tinybar amount', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake], { priceAsset: 'hbar' });
    cleanup = shop.close;
    const { second } = await pay(`${shop.url}${PING_ROUTE}`);
    expect(second.status).toBe(200);
    expect(fake.settled[0]).toMatchObject({ asset: '0.0.0', amount: '10000000' });
  });

  test('health reports the active rung and the registration document lists the x402 service', async () => {
    const shop = await startTestShop([fakeFacilitator()]);
    cleanup = shop.close;
    const health = (await (await fetch(`${shop.url}/health`)).json()) as { facilitator: { rung: number }; payTo: string };
    expect(health.facilitator.rung).toBe(1);
    expect(health.payTo).toBe(TEST_SHOP_ACCOUNT);
    const reg = (await (await fetch(`${shop.url}/.well-known/agent-registration.json`)).json()) as {
      services: { name: string; endpoint: string; payTo: string }[];
    };
    expect(reg.services[0]).toMatchObject({ name: 'x402', endpoint: `${shop.url}/x402/`, payTo: TEST_SHOP_ACCOUNT });
  });

  test('oversized bodies are refused before payment', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake]);
    cleanup = shop.close;
    const res = await fetch(`${shop.url}${PING_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(9000) }),
    });
    expect(res.status).toBe(413);
    expect(fake.calls.settle).toBe(0);
  });
});
