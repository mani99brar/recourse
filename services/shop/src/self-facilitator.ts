// In-process x402 facilitator for the last ladder rung. It adds the fee payer's signature to the
// payer's partially signed transfer and submits it, so the fee payer account needs HBAR for fees.

import { PrivateKey } from '@hiero-ledger/sdk';
import { x402Facilitator } from '@x402/core/facilitator';
import type { FacilitatorClient } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import {
  createHederaClient,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  type FacilitatorHederaSigner,
} from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/facilitator';

export interface SelfFacilitatorOptions {
  network: 'hedera:testnet';
  feePayerAccountId: string;
  /** 32 secp256k1 key bytes. Zeroed by this function once the SDK key is built. */
  feePayerKeyBytes: Uint8Array;
  /** Mirror node root, with or without `/api/v1`. */
  mirrorUrl: string;
}

export function createSelfFacilitator(options: SelfFacilitatorOptions): FacilitatorClient {
  let key: PrivateKey;
  try {
    key = PrivateKey.fromBytesECDSA(options.feePayerKeyBytes);
  } finally {
    options.feePayerKeyBytes.fill(0);
  }
  const mirrorNodeUrl = options.mirrorUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  const signer: FacilitatorHederaSigner = {
    getAddresses: () => [options.feePayerAccountId],
    signAndSubmitTransaction: createHederaSignAndSubmitTransaction((network) => createHederaClient(network), key),
    verifyPayerSignature: createHederaVerifyPayerSignature({ mirrorNodeUrl }),
    preflightTransfer: createHederaPreflightTransfer({ mirrorNodeUrl }),
  };
  const facilitator = new x402Facilitator().register(
    options.network,
    new ExactHederaScheme(signer, { aliasPolicy: 'reject' }),
  );
  return {
    // The facilitator reports plain strings for networks; they are CAIP-2 ids by construction.
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
  };
}
