import { afterEach, describe, expect, test } from 'vitest';
import { PrivateKey } from '@hiero-ledger/sdk';
import { createClientHederaSigner } from '@x402/hedera';
import { PING_ROUTE } from '../../shop/src/app.js';
import { USDC_TOKEN_ID } from '../../shop/src/payments.js';
import { fakeFacilitator } from '../../shop/test/fake-facilitator.js';
import { TEST_SHOP_ACCOUNT, startTestShop } from '../../shop/test/helpers.js';
import { PaymentRefused, chooseRequirement, payExactly, probe402, termsOf, type SignedPayment } from '../src/x402-pay.js';

const AGENT = '0.0.990300';
const init = (): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function signer() {
  return createClientHederaSigner(AGENT, PrivateKey.generateECDSA(), { network: 'hedera:testnet' });
}

describe('reading the 402', () => {
  test('takes price and payTo from the 402 and checks them', async () => {
    const shop = await startTestShop([fakeFacilitator()]);
    cleanup = shop.close;
    const probe = await probe402(`${shop.url}${PING_ROUTE}`, init());
    const r = chooseRequirement(probe.paymentRequired, { asset: USDC_TOKEN_ID, expectedPayTo: TEST_SHOP_ACCOUNT });
    expect(termsOf(r)).toEqual({ network: 'hedera:testnet', asset: USDC_TOKEN_ID, amount: '50000', payTo: TEST_SHOP_ACCOUNT });
  });

  test('refuses another network, another asset, an alias payTo or a payTo that differs from the registration', async () => {
    const shop = await startTestShop([fakeFacilitator()]);
    cleanup = shop.close;
    const { paymentRequired } = await probe402(`${shop.url}${PING_ROUTE}`, init());
    const base = paymentRequired.accepts[0]!;
    const code = (f: () => unknown) => {
      try {
        f();
        return 'none';
      } catch (e) {
        return (e as PaymentRefused).code;
      }
    };
    expect(code(() => chooseRequirement({ ...paymentRequired, accepts: [{ ...base, network: 'hedera:mainnet' }] }, { asset: USDC_TOKEN_ID }))).toBe('wrong_network');
    expect(code(() => chooseRequirement(paymentRequired, { asset: '0.0.0' }))).toBe('wrong_asset');
    expect(
      code(() => chooseRequirement({ ...paymentRequired, accepts: [{ ...base, payTo: '0x00000000000000000000000000000000000004d2' }] }, { asset: USDC_TOKEN_ID })),
    ).toBe('payto_alias');
    expect(code(() => chooseRequirement(paymentRequired, { asset: USDC_TOKEN_ID, expectedPayTo: '0.0.1' }))).toBe('payto_mismatch');
  });

  test('a route that does not answer 402 is refused', async () => {
    const shop = await startTestShop([fakeFacilitator()]);
    cleanup = shop.close;
    await expect(probe402(`${shop.url}/health`, { method: 'GET' })).rejects.toMatchObject({ code: 'no_402' });
  });
});

describe('paying exactly the approved terms', () => {
  test('journals the signed transaction id before the paid request, then returns the settlement', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake]);
    cleanup = shop.close;
    const url = `${shop.url}${PING_ROUTE}`;
    const { paymentRequired } = await probe402(url, init());
    const approved = termsOf(chooseRequirement(paymentRequired, { asset: USDC_TOKEN_ID }));
    const events: string[] = [];
    let signed: SignedPayment | null = null;
    const paid = await payExactly({
      url,
      init: init(),
      approved,
      signer: signer(),
      onSigned: (s) => {
        events.push(`signed settle_calls=${fake.calls.settle}`);
        signed = s;
      },
    });
    expect(events).toEqual(['signed settle_calls=0']);
    expect(paid.status).toBe(200);
    expect(paid.settlement?.success).toBe(true);
    expect(paid.settlement?.transaction).toBe(`fake-settlement:${signed!.txId}`);
    expect(signed!.txId.startsWith('0.0.990001@')).toBe(true);
  });

  test('if journaling the signature fails, nothing is sent', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake]);
    cleanup = shop.close;
    const url = `${shop.url}${PING_ROUTE}`;
    const { paymentRequired } = await probe402(url, init());
    const approved = termsOf(chooseRequirement(paymentRequired, { asset: USDC_TOKEN_ID }));
    await expect(
      payExactly({
        url,
        init: init(),
        approved,
        signer: signer(),
        onSigned: () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(fake.calls.settle).toBe(0);
  });

  test('a changed amount or payTo aborts before signing', async () => {
    const fake = fakeFacilitator();
    const shop = await startTestShop([fake]);
    cleanup = shop.close;
    const url = `${shop.url}${PING_ROUTE}`;
    const { paymentRequired } = await probe402(url, init());
    const offered = termsOf(chooseRequirement(paymentRequired, { asset: USDC_TOKEN_ID }));
    let signedCount = 0;
    for (const approved of [{ ...offered, amount: '40000' }, { ...offered, payTo: '0.0.1234' }]) {
      await expect(
        payExactly({ url, init: init(), approved, signer: signer(), onSigned: () => (signedCount += 1) }),
      ).rejects.toThrow(/terms_changed|rejected by spendControls/);
    }
    expect(signedCount).toBe(0);
    expect(fake.calls.settle).toBe(0);
  });
});
