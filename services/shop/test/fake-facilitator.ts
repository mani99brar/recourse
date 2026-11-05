// TEST ONLY. A fake x402 facilitator: it checks the signed transfer offline and "settles" without
// touching any network. Its settlement ids start with `fake-settlement:` so they can never be
// mistaken for a Hedera transaction id.

import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { inspectHederaTransaction } from '@x402/hedera';

export const FAKE_FEE_PAYER = '0.0.990001';

export type FakeMode = 'ok' | 'http500' | 'timeout' | 'reject';

export interface FakeFacilitator extends FacilitatorClient {
  mode: FakeMode;
  calls: { verify: number; settle: number; supported: number };
  settled: { txId: string; payer: string; amount: string; payTo: string; asset: string }[];
}

function payerOf(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  feePayer: string,
): { payer: string; ok: boolean; reason?: string } {
  const tx = (payload.payload as { transaction?: unknown }).transaction;
  if (typeof tx !== 'string') return { payer: '', ok: false, reason: 'no transaction' };
  const info = inspectHederaTransaction(tx);
  const transfers = requirements.asset === '0.0.0' ? info.hbarTransfers : (info.tokenTransfers[requirements.asset] ?? []);
  const toPayTo = transfers.filter((t) => t.accountId === requirements.payTo).reduce((s, t) => s + BigInt(t.amount), 0n);
  const debit = transfers.find((t) => BigInt(t.amount) < 0n);
  if (toPayTo !== BigInt(requirements.amount)) return { payer: debit?.accountId ?? '', ok: false, reason: 'amount mismatch' };
  if (info.transactionIdAccountId !== feePayer) return { payer: debit?.accountId ?? '', ok: false, reason: 'fee payer mismatch' };
  return { payer: debit?.accountId ?? '', ok: true };
}

export function fakeFacilitator(feePayer = FAKE_FEE_PAYER): FakeFacilitator {
  const fake: FakeFacilitator = {
    mode: 'ok',
    calls: { verify: 0, settle: 0, supported: 0 },
    settled: [],
    async getSupported(): Promise<SupportedResponse> {
      fake.calls.supported += 1;
      return {
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer } }],
        extensions: [],
        signers: { 'hedera:*': [feePayer] },
      };
    },
    async verify(payload, requirements): Promise<VerifyResponse> {
      fake.calls.verify += 1;
      const r = payerOf(payload, requirements, feePayer);
      return r.ok ? { isValid: true, payer: r.payer } : { isValid: false, invalidReason: r.reason ?? 'invalid', payer: r.payer };
    },
    async settle(payload, requirements): Promise<SettleResponse> {
      fake.calls.settle += 1;
      if (fake.mode === 'http500') throw new Error('Facilitator settle failed (503): fake outage');
      if (fake.mode === 'timeout') {
        const e = new Error('Facilitator settle request timed out after 30000ms');
        e.name = 'TimeoutError';
        throw e;
      }
      const r = payerOf(payload, requirements, feePayer);
      if (fake.mode === 'reject' || !r.ok) {
        return { success: false, errorReason: r.reason ?? 'transaction_failed', transaction: '', network: requirements.network, payer: r.payer };
      }
      const info = inspectHederaTransaction((payload.payload as { transaction: string }).transaction);
      const txId = `fake-settlement:${info.transactionId}`;
      fake.settled.push({ txId, payer: r.payer, amount: requirements.amount, payTo: requirements.payTo, asset: requirements.asset });
      return { success: true, transaction: txId, network: requirements.network, payer: r.payer, amount: requirements.amount };
    },
  };
  return fake;
}
