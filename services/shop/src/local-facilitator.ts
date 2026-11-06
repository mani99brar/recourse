// LOCAL RUNS AND TESTS ONLY. A simulated x402 facilitator: it checks the signed transfer offline
// and "settles" without touching any network; no money moves. Its settlement ids start with
// `fake-settlement:` so they can never be mistaken for a Hedera transaction id.

import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { inspectHederaTransaction } from '@x402/hedera';
import { HBAR_ASSET_ID } from '@recourse/shared';

export const FAKE_FEE_PAYER = '0.0.990001';

/**
 * How the next settle behaves:
 * - `ok`: settles;
 * - `http500`, `timeout`: the facilitator is down; nothing moves;
 * - `reject`: a payment-side refusal (`invalid_...`); nothing moves;
 * - `submit_failed`: the facilitator could not submit (`transaction_failed`); nothing moves;
 * - `land_then_timeout`: the transfer lands, then the reply times out, so the shop never hears of it.
 */
export type FakeMode = 'ok' | 'http500' | 'timeout' | 'reject' | 'submit_failed' | 'land_then_timeout';

export interface FakeFacilitator extends FacilitatorClient {
  /** The mode for every settle once `faults` is used up. */
  mode: FakeMode;
  /** Modes for the next settles, in order. */
  faults: FakeMode[];
  calls: { verify: number; settle: number; supported: number };
  /**
   * Every transfer that moved. `txId` is what the shop was told: `fake-settlement:<id>`, or the bare
   * Hedera id for a transfer that landed unannounced (`landed: true`). `hederaTxId` is always the bare id.
   */
  settled: { txId: string; hederaTxId: string; payer: string; amount: string; payTo: string; asset: string; landed?: true }[];
}

function payerOf(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  feePayer: string,
): { payer: string; ok: boolean; reason?: string } {
  const tx = (payload.payload as { transaction?: unknown }).transaction;
  if (typeof tx !== 'string') return { payer: '', ok: false, reason: 'invalid_exact_hedera_payload_transaction_could_not_be_decoded' };
  const info = inspectHederaTransaction(tx);
  const transfers = requirements.asset === HBAR_ASSET_ID ? info.hbarTransfers : (info.tokenTransfers[requirements.asset] ?? []);
  const toPayTo = transfers.filter((t) => t.accountId === requirements.payTo).reduce((s, t) => s + BigInt(t.amount), 0n);
  const debit = transfers.find((t) => BigInt(t.amount) < 0n);
  if (toPayTo !== BigInt(requirements.amount)) return { payer: debit?.accountId ?? '', ok: false, reason: 'invalid_exact_hedera_payload_amount_mismatch' };
  if (info.transactionIdAccountId !== feePayer) return { payer: debit?.accountId ?? '', ok: false, reason: 'invalid_exact_hedera_payload_fee_payer_mismatch' };
  return { payer: debit?.accountId ?? '', ok: true };
}

export function fakeFacilitator(feePayer = FAKE_FEE_PAYER): FakeFacilitator {
  const fake: FakeFacilitator = {
    mode: 'ok',
    faults: [],
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
      const mode = fake.faults.shift() ?? fake.mode;
      const timeout = () => {
        const e = new Error('Facilitator settle request timed out after 30000ms');
        e.name = 'TimeoutError';
        return e;
      };
      if (mode === 'http500') throw new Error('Facilitator settle failed (503): fake outage');
      if (mode === 'timeout') throw timeout();
      const r = payerOf(payload, requirements, feePayer);
      if (mode === 'reject' || !r.ok) {
        return { success: false, errorReason: r.reason ?? 'invalid_exact_hedera_payload_signature_invalid', transaction: '', network: requirements.network, payer: r.payer };
      }
      if (mode === 'submit_failed') {
        return { success: false, errorReason: 'transaction_failed', errorMessage: 'fake: the fee payer could not submit', transaction: '', network: requirements.network, payer: r.payer };
      }
      const info = inspectHederaTransaction((payload.payload as { transaction: string }).transaction);
      const moved = { payer: r.payer, amount: requirements.amount, payTo: requirements.payTo, asset: requirements.asset, hederaTxId: info.transactionId };
      if (mode === 'land_then_timeout') {
        fake.settled.push({ ...moved, txId: info.transactionId, landed: true });
        throw timeout();
      }
      const txId = `fake-settlement:${info.transactionId}`;
      fake.settled.push({ ...moved, txId });
      return { success: true, transaction: txId, network: requirements.network, payer: r.payer, amount: requirements.amount };
    },
  };
  return fake;
}
