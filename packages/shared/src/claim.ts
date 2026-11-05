// The claim as stored by `RecourseClaims` and returned by `getClaim`, in storage field order.

import type { Address, Hex } from 'viem';
import type { Answer, ClaimStatus, Gap, Ruling } from './codes.js';
import type { RecordRefs } from './records.js';

export interface Claim {
  orderId: Hex;
  shop: Address;
  platform: Address;
  refs: RecordRefs;
  /** µUSDC. */
  basketUsdc: bigint;
  /** µUSDC; at most basketUsdc. */
  netLossUsdc: bigint;
  /** Unix seconds. */
  filedAt: bigint;
  /** Unix seconds; 0 before the pre-check. */
  preCheckedAt: bigint;
  gap: Gap;
  answer: Answer;
  packHash: Hex;
  /** Zero address until contested. */
  contestedBy: Address;
  sendCount: number;
  lastSendAt: bigint;
  lastMessageId: Hex;
  disputeId: bigint;
  ruling: Ruling;
  /** Court attempts reported with the ruling: 1 or 2 (0 before a ruling). */
  attempts: number;
  status: ClaimStatus;
}
