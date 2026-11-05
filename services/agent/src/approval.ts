// Approval of an order's rendered text. One EIP-712 type for both signers: the agent key signs a
// mandate approval (amounts within the spend limit), the buyer key signs above it. The signature
// binds the order, the text the buyer saw, the amount and the payee.

import { recoverTypedDataAddress, type Address, type Hex, type LocalAccount } from 'viem';
import { HEDERA_TESTNET_CHAIN_ID } from '@recourse/shared';

export const APPROVAL_DOMAIN = { name: 'Recourse', version: '1', chainId: HEDERA_TESTNET_CHAIN_ID } as const;

export const APPROVAL_TYPES = {
  RecourseApproval: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'textHash', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'payTo', type: 'string' },
    { name: 'decision', type: 'string' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export type Decision = 'approved' | 'not_approved';

export interface ApprovalMessage {
  orderId: Hex;
  textHash: Hex;
  /** Smallest units of the payment asset, as a decimal string. */
  amount: string;
  payTo: string;
  decision: Decision;
  /** Unix seconds. */
  expiresAt: number;
}

function typed(message: ApprovalMessage) {
  return {
    domain: APPROVAL_DOMAIN,
    types: APPROVAL_TYPES,
    primaryType: 'RecourseApproval' as const,
    message: {
      orderId: message.orderId,
      textHash: message.textHash,
      amount: BigInt(message.amount),
      payTo: message.payTo,
      decision: message.decision,
      expiresAt: BigInt(message.expiresAt),
    },
  };
}

export async function signApproval(account: LocalAccount, message: ApprovalMessage): Promise<Hex> {
  return account.signTypedData(typed(message));
}

/** The address that signed `message`, or null when the signature does not parse. */
export async function approvalSigner(message: ApprovalMessage, signature: Hex): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({ ...typed(message), signature });
  } catch {
    return null;
  }
}
