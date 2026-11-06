// x402 buyer: read a 402, check its terms, and pay exactly the approved terms on hedera:testnet.
//
// The Hedera transaction id of a payment is fixed when the payer signs (the payer's client picks
// it from the facilitator's fee payer and the clock). `payExactly` reports it through `onSigned`
// before the paid request is sent, so a caller can journal it and later look it up on the mirror
// node instead of guessing whether a lost request was paid.

import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { inspectHederaTransaction, type ClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { HBAR_ASSET_ID } from '@recourse/shared';

export const NETWORK = 'hedera:testnet' as const;
const ACCOUNT_ID = /^0\.0\.\d+$/;

export type FetchLike = typeof globalThis.fetch;

export class PaymentRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PaymentRefused';
  }
}

/**
 * A signed Hedera payment that has not reached consensus by its valid start + this many seconds is
 * taken as dead: the default validity window is 120 s, and the rest is margin for mirror lag.
 */
export const PAYMENT_DEAD_AFTER_S = 240;

export interface Terms {
  network: string;
  asset: string;
  /** Atomic units as a decimal string. */
  amount: string;
  payTo: string;
}

export interface Probe {
  status: number;
  paymentRequired: PaymentRequired;
}

const httpClientForDecode = new x402HTTPClient(new x402Client());

/** Sends the request unpaid and decodes the 402. Throws `no_402` for any other status. */
export async function probe402(url: string, init: RequestInit, fetchImpl: FetchLike = fetch): Promise<Probe> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (res.status !== 402) {
    throw new PaymentRefused('no_402', `expected 402 from ${new URL(url).pathname}, got ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const paymentRequired = httpClientForDecode.getPaymentRequiredResponse((name) => res.headers.get(name), body);
  return { status: res.status, paymentRequired };
}

/**
 * Picks the one `exact` requirement on hedera:testnet and checks it against what the agent will
 * accept. `expectedPayTo`, when given, comes from the shop's registration document.
 */
export function chooseRequirement(
  paymentRequired: PaymentRequired,
  expect: { asset: string; expectedPayTo?: string },
): PaymentRequirements {
  const candidates = paymentRequired.accepts.filter((r) => r.scheme === 'exact');
  if (candidates.length === 0) throw new PaymentRefused('no_exact_scheme', 'the 402 offers no exact payment');
  const onNetwork = candidates.filter((r) => r.network === NETWORK);
  if (onNetwork.length === 0) {
    throw new PaymentRefused('wrong_network', `the 402 asks for ${candidates.map((r) => r.network).join(', ')}, not ${NETWORK}`);
  }
  const inAsset = onNetwork.filter((r) => r.asset === expect.asset);
  if (inAsset.length === 0) {
    throw new PaymentRefused('wrong_asset', `the 402 asks for asset ${onNetwork.map((r) => r.asset).join(', ')}, not ${expect.asset}`);
  }
  if (inAsset.length > 1) throw new PaymentRefused('ambiguous_402', 'the 402 offers more than one matching payment');
  const r = inAsset[0]!;
  if (!ACCOUNT_ID.test(r.payTo)) throw new PaymentRefused('payto_alias', `payTo ${r.payTo} is not a 0.0.N account id`);
  if (expect.expectedPayTo !== undefined && r.payTo !== expect.expectedPayTo) {
    throw new PaymentRefused('payto_mismatch', `payTo ${r.payTo} differs from the registered ${expect.expectedPayTo}`);
  }
  if (!/^[1-9]\d*$/.test(r.amount)) throw new PaymentRefused('bad_amount', `amount ${r.amount} is not a positive integer`);
  if (typeof r.extra?.feePayer !== 'string' || !ACCOUNT_ID.test(r.extra.feePayer)) {
    throw new PaymentRefused('no_fee_payer', 'the 402 names no facilitator fee payer');
  }
  return r;
}

export function termsOf(r: PaymentRequirements): Terms {
  return { network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo };
}

export interface SignedPayment {
  /** Hedera transaction id, `0.0.N@seconds.nanos`. */
  txId: string;
  feePayer: string;
}

export interface PaidResponse {
  status: number;
  body: unknown;
  settlement: SettleResponse | null;
  signed: SignedPayment | null;
}

/**
 * Pays for one request with exactly `approved`. The second 402 must offer the same terms; any
 * change aborts before signing. `onSigned` runs after signing and before sending; if it throws,
 * nothing is sent.
 */
export async function payExactly(input: {
  url: string;
  init: RequestInit;
  approved: Terms;
  signer: ClientHederaSigner;
  onSigned: (signed: SignedPayment) => void;
  fetchImpl?: FetchLike;
}): Promise<PaidResponse> {
  const { approved } = input;
  let signed: SignedPayment | null = null;
  // The payment wrapper may swallow or re-wrap errors from the selector and signer; keep the refusal.
  let refused: PaymentRefused | null = null;
  const refuse = (e: PaymentRefused): never => {
    refused = e;
    throw e;
  };

  const guardedSigner: ClientHederaSigner = {
    accountId: input.signer.accountId,
    createPartiallySignedTransferTransaction: async (requirements) => {
      try {
        assertSameTerms(termsOf(requirements), approved);
      } catch (e) {
        refuse(e as PaymentRefused);
      }
      const tx = await input.signer.createPartiallySignedTransferTransaction(requirements);
      const info = inspectHederaTransaction(tx);
      try {
        checkSignedTransfer(info, input.signer.accountId, approved);
      } catch (e) {
        if (e instanceof PaymentRefused) refuse(e);
        throw e;
      }
      const feePayer = String(requirements.extra.feePayer);
      if (info.transactionIdAccountId !== feePayer) {
        refuse(new PaymentRefused('fee_payer_mismatch', 'signed transaction is not paid by the facilitator fee payer'));
      }
      const s = { txId: info.transactionId, feePayer };
      input.onSigned(s);
      signed = s;
      return tx;
    },
  };

  const client = new x402Client((_version, requirements) => {
    const match = requirements.filter((r) => sameTerms(termsOf(r), approved));
    if (match.length !== 1) {
      refuse(new PaymentRefused('terms_changed', 'the 402 no longer offers the approved amount, asset and payTo'));
    }
    return match[0]!;
  });
  client.register(NETWORK, new ExactHederaScheme(guardedSigner));
  client.setSpendControls({
    maxAmountPerPayment: false,
    allowedAssets: [{ network: NETWORK, asset: approved.asset, maxAmountPerPayment: approved.amount }],
  });
  const httpClient = new x402HTTPClient(client);
  const payingFetch = wrapFetchWithPayment(input.fetchImpl ?? fetch, httpClient);

  let res: Response;
  try {
    res = await payingFetch(input.url, input.init);
  } catch (error) {
    if (refused) throw refused;
    if (!signed) {
      // Refused inside the payment wrapper (spend controls) before signing: read the terms again.
      const current = await probe402(input.url, input.init, input.fetchImpl ?? fetch).catch(() => null);
      if (current && !current.paymentRequired.accepts.some((r) => sameTerms(termsOf(r), approved))) {
        throw new PaymentRefused('terms_changed', 'the 402 no longer offers the approved amount, asset and payTo');
      }
    }
    throw error;
  }
  if (refused) throw refused;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep the raw text
  }
  if (res.status === 402 && !signed) {
    // Nothing was signed; a 402 whose terms no longer match the approval is a change of terms.
    let offered: PaymentRequirements[] = [];
    try {
      offered = httpClient.getPaymentRequiredResponse((name) => res.headers.get(name), body).accepts;
    } catch {
      offered = [];
    }
    if (offered.length > 0 && !offered.some((r) => sameTerms(termsOf(r), approved))) {
      throw new PaymentRefused('terms_changed', 'the 402 no longer offers the approved amount, asset and payTo');
    }
  }
  let settlement: SettleResponse | null = null;
  try {
    settlement = httpClient.getPaymentSettleResponse((name) => res.headers.get(name));
  } catch {
    settlement = null;
  }
  return { status: res.status, body, settlement, signed };
}

export function sameTerms(a: Terms, b: Terms): boolean {
  return a.network === b.network && a.asset === b.asset && a.amount === b.amount && a.payTo === b.payTo;
}

function assertSameTerms(offered: Terms, approved: Terms): void {
  if (!sameTerms(offered, approved)) {
    throw new PaymentRefused('terms_changed', 'payment terms differ from the approved terms');
  }
}

function checkSignedTransfer(
  info: ReturnType<typeof inspectHederaTransaction>,
  payer: string,
  approved: Terms,
): void {
  if (info.hasNonTransferOperations) throw new PaymentRefused('bad_transfer', 'signed transaction does more than transfer');
  const amount = BigInt(approved.amount);
  const transfers = approved.asset === HBAR_ASSET_ID ? info.hbarTransfers : (info.tokenTransfers[approved.asset] ?? []);
  const net = (account: string) =>
    transfers.filter((t) => t.accountId === account).reduce((sum, t) => sum + BigInt(t.amount), 0n);
  if (net(approved.payTo) !== amount || net(payer) !== -amount) {
    throw new PaymentRefused('bad_transfer', 'signed transfer does not move exactly the approved amount to payTo');
  }
}
