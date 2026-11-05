import { afterEach, describe, expect, test } from 'vitest';
import { PrivateKey } from '@hiero-ledger/sdk';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { FacilitatorTimeoutError } from '@x402/core/server';
import { SettleError } from '@x402/core/types';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { memoryLogger } from '@recourse/records';
import { PING_ROUTE } from '../src/app.js';
import { FacilitatorLadder, isFacilitatorSideFailure, parseFacilitatorUrls } from '../src/facilitators.js';
import { NETWORK } from '../src/payments.js';
import { fakeFacilitator } from './fake-facilitator.js';
import { startTestShop } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function payOnce(url: string) {
  const signer = createClientHederaSigner('0.0.990200', PrivateKey.generateECDSA(), { network: 'hedera:testnet' });
  const http = new x402HTTPClient(
    new x402Client().register('hedera:testnet', new ExactHederaScheme(signer)).setSpendControls(false),
  );
  const first = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
  const payload = await http.createPaymentPayload(required);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...http.encodePaymentSignatureHeader(payload) },
    body: '{}',
  });
  return { status: res.status, feePayer: String(required.accepts[0]!.extra.feePayer) };
}

describe('facilitator URL list', () => {
  test('parses URLs and the self-hosted token', () => {
    expect(parseFacilitatorUrls(' https://x402.org/facilitator/ , https://api.testnet.blocky402.com,self')).toEqual([
      'https://x402.org/facilitator',
      'https://api.testnet.blocky402.com',
      'self',
    ]);
    expect(() => parseFacilitatorUrls('')).toThrow(/not set/);
    expect(() => parseFacilitatorUrls('ftp://x')).toThrow(/not a URL/);
  });
});

describe('failure classes', () => {
  test('5xx, timeouts and unreachable hosts are the facilitator; 4xx and refusals are not', () => {
    expect(isFacilitatorSideFailure(new FacilitatorTimeoutError('settle', 30000))).toBe(true);
    expect(isFacilitatorSideFailure(new Error('Facilitator settle failed (502): bad gateway'))).toBe(true);
    expect(isFacilitatorSideFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isFacilitatorSideFailure(new SettleError(503, { success: false, transaction: '', network: 'hedera:testnet' }))).toBe(true);
    expect(isFacilitatorSideFailure(new SettleError(400, { success: false, transaction: '', network: 'hedera:testnet' }))).toBe(false);
    expect(isFacilitatorSideFailure(new Error('Facilitator settle failed (400): bad request'))).toBe(false);
  });
});

describe('ladder', () => {
  test('boot picks the first rung that lists exact on hedera:testnet', async () => {
    const down = fakeFacilitator('0.0.990011');
    down.getSupported = async () => {
      throw new Error('Facilitator getSupported failed (503): down');
    };
    const up = fakeFacilitator('0.0.990012');
    const ladder = new FacilitatorLadder(
      [
        { index: 1, url: 'fake://1', create: () => down },
        { index: 2, url: 'fake://2', create: () => up },
      ],
      { network: NETWORK, log: memoryLogger() },
    );
    const rung = await ladder.select();
    expect(rung.index).toBe(2);
  });

  test('a rung is never built before the ladder reaches it', async () => {
    let built = 0;
    const ladder = new FacilitatorLadder(
      [
        { index: 1, url: 'fake://1', create: () => fakeFacilitator() },
        {
          index: 2,
          url: 'self',
          create: () => {
            built += 1;
            return fakeFacilitator();
          },
        },
      ],
      { network: NETWORK, log: memoryLogger() },
    );
    await ladder.select();
    expect(built).toBe(0);
  });

  test('three facilitator-side settle failures move to the next rung and refresh the fee payer', async () => {
    const first = fakeFacilitator('0.0.990011');
    const second = fakeFacilitator('0.0.990012');
    const shop = await startTestShop([first, second]);
    cleanup = shop.close;
    first.mode = 'http500';
    const url = `${shop.url}${PING_ROUTE}`;
    for (let i = 0; i < 3; i++) {
      const r = await payOnce(url);
      expect(r.feePayer).toBe('0.0.990011');
      expect(r.status).not.toBe(200);
    }
    expect(shop.ladder.state().rung).toBe(2);
    const after = await payOnce(url);
    expect(after.feePayer).toBe('0.0.990012');
    expect(after.status).toBe(200);
    expect(second.settled).toHaveLength(1);
    expect(shop.log.lines.some((l) => l.event === 'facilitator_switched')).toBe(true);
  });

  test('payment-side refusals do not count toward failover', async () => {
    const first = fakeFacilitator('0.0.990011');
    const second = fakeFacilitator('0.0.990012');
    const shop = await startTestShop([first, second]);
    cleanup = shop.close;
    first.mode = 'reject';
    for (let i = 0; i < 4; i++) await payOnce(`${shop.url}${PING_ROUTE}`);
    expect(shop.ladder.state().rung).toBe(1);
  });

  test('with no later rung working, the ladder stays and keeps serving', async () => {
    const only = fakeFacilitator('0.0.990011');
    const shop = await startTestShop([only]);
    cleanup = shop.close;
    only.mode = 'timeout';
    for (let i = 0; i < 3; i++) await payOnce(`${shop.url}${PING_ROUTE}`);
    expect(shop.ladder.state().rung).toBe(1);
    only.mode = 'ok';
    expect((await payOnce(`${shop.url}${PING_ROUTE}`)).status).toBe(200);
  });
});
