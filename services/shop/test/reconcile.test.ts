// The shop's mirror check of a settle it never heard back about: a transfer counts as the order only
// when it succeeded and moved exactly the price from the payer to the shop.

import { describe, expect, test } from 'vitest';
import { getAddress } from 'viem';
import type { MirrorTransaction } from '@recourse/records';
import { USDC_TOKEN_ID } from '../src/payments.js';
import { checkSettlements } from '../src/reconcile.js';
import { TEST_SHOP_ACCOUNT } from './helpers.js';

const BUYER = '0.0.990200';
const PLATFORM = getAddress('0x00000000000000000000000000000000000000a1');
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

describe('mirror check', () => {
  test('a transfer the mirror shows with another amount or payee is not the order', async () => {
    const unknown = {
      type: 'settle_unknown' as const,
      at: '2026-01-01T00:00:00.000Z',
      orderId: H(7),
      orderNonce: H(8),
      platform: PLATFORM,
      sku: 'cap-red',
      quantity: 1,
      txId: '0.0.990001@1800000000.000000005',
      payer: BUYER,
      amount: '1000000',
      asset: USDC_TOKEN_ID,
      payTo: TEST_SHOP_ACCOUNT,
      reason: 'timeout',
      refs: null,
    };
    const tx = (amount: bigint, payTo: string): MirrorTransaction => ({
      transactionId: '0.0.990001-1800000000-000000005',
      result: 'SUCCESS',
      consensusTimestamp: '1800000001.000000000',
      name: 'CRYPTOTRANSFER',
      payer: '0.0.990001',
      transfers: [],
      tokenTransfers: [
        { tokenId: USDC_TOKEN_ID, account: BUYER, amount: -amount },
        { tokenId: USDC_TOKEN_ID, account: payTo, amount },
      ],
    });
    const check = async (t: MirrorTransaction | null) =>
      (await checkSettlements({ rows: [unknown], mirror: { transaction: async () => t }, now: 1_800_000_010 }))[0]!;
    expect((await check(tx(1_000_000n, TEST_SHOP_ACCOUNT))).outcome).toBe('paid');
    expect(await check(tx(999_999n, TEST_SHOP_ACCOUNT))).toMatchObject({ outcome: 'dead', reason: 'transfer_mismatch' });
    expect(await check(tx(1_000_000n, '0.0.4242'))).toMatchObject({ outcome: 'dead', reason: 'transfer_mismatch' });
    expect(await check({ ...tx(1_000_000n, TEST_SHOP_ACCOUNT), result: 'INSUFFICIENT_TOKEN_BALANCE' })).toMatchObject({ outcome: 'dead', reason: 'transaction INSUFFICIENT_TOKEN_BALANCE' });
    expect((await check(null)).outcome).toBe('open');
    expect((await check(tx(1_000_000n, TEST_SHOP_ACCOUNT))).rows.map((r) => r.type)).toEqual(['order_paid', 'settle_resolved']);
  });
});
