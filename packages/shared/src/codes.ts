// Numeric codes shared with the contracts. Ordinals are fixed; never reorder.

/** Pre-check gap. 255 = no gap code (not enough record, or a missing record; see Answer). */
export const Gap = {
  None: 0,
  AskedVsShown: 1,
  ShownVsOrdered: 2,
  OrderedVsDelivered: 3,
  NoCode: 255,
} as const;
export type Gap = (typeof Gap)[keyof typeof Gap];
export const GAPS = [0, 1, 2, 3, 255] as const satisfies readonly Gap[];

/** Who the pre-check (or a ruling) says is at fault. */
export const Answer = {
  Unknown: 0,
  Platform: 1,
  Merchant: 2,
  Neither: 3,
} as const;
export type Answer = (typeof Answer)[keyof typeof Answer];

/** Kleros ruling: 0 refused to rule, 1 platform pays, 2 shop's claim fails, 3 neither at fault. */
export const Ruling = {
  Refused: 0,
  Platform: 1,
  Merchant: 2,
  Neither: 3,
} as const;
export type Ruling = (typeof Ruling)[keyof typeof Ruling];

/** Display side for an answer. */
export type Side = 'platform' | 'shop' | 'neither' | 'none';

export function sideOf(answer: Answer): Side {
  return answer === 1 ? 'platform' : answer === 2 ? 'shop' : answer === 3 ? 'neither' : 'none';
}

export function isGap(value: unknown): value is Gap {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 255;
}

export function isAnswer(value: unknown): value is Answer {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

export const isRuling = isAnswer as (value: unknown) => value is Ruling;

/** Claim status on Hedera (`RecourseClaims`). None = no claim stored. */
export const ClaimStatus = {
  None: 0,
  Filed: 1,
  PreChecked: 2,
  Contested: 3,
  AtCourt: 4,
  Ruled: 5,
  Settled: 6,
  Closed: 7,
  Expired: 8,
} as const;
export type ClaimStatus = (typeof ClaimStatus)[keyof typeof ClaimStatus];

/** Case state on Arbitrum (`RecourseCase`). */
export const CaseState = {
  None: 0,
  Received: 1,
  Opened: 2,
  RefilePending: 3,
  Ruled: 4,
  Relayed: 5,
  Stale: 6,
} as const;
export type CaseState = (typeof CaseState)[keyof typeof CaseState];

/** CCIP OffRamp `getExecutionState` values. */
export const ExecutionState = {
  Untouched: 0,
  InProgress: 1,
  Success: 2,
  Failure: 3,
} as const;
export type ExecutionState = (typeof ExecutionState)[keyof typeof ExecutionState];

/** How the Hedera claims contract talks to Arbitrum. */
export const BridgeMode = {
  Both: 0,
  OutOnly: 1,
  None: 2,
} as const;
export type BridgeMode = (typeof BridgeMode)[keyof typeof BridgeMode];

/** Result of decoding a bridge message. */
export const DecodeStatus = {
  Ok: 0,
  BadLength: 1,
  BadVersion: 2,
  DirtyWord: 3,
  BadCode: 4,
} as const;
export type DecodeStatus = (typeof DecodeStatus)[keyof typeof DecodeStatus];

/** `RulingIgnored(claimIdOrZero, reason)` reasons on Hedera. 7 is unused. */
export const RulingIgnoredReason = {
  WrongSourceChain: 1,
  WrongSender: 2,
  Undecodable: 3,
  WrongMode: 4,
  UnknownClaim: 5,
  NotAtCourt: 6,
  RefusedOnFirstAttempt: 8,
} as const;
export type RulingIgnoredReason = (typeof RulingIgnoredReason)[keyof typeof RulingIgnoredReason];

/** `ClaimRejected(messageId, reason)` reasons on Arbitrum. */
export const ClaimRejectedReason = {
  WrongSourceChain: 1,
  WrongSender: 2,
  Undecodable: 3,
  UnknownVersion: 4,
} as const;
export type ClaimRejectedReason = (typeof ClaimRejectedReason)[keyof typeof ClaimRejectedReason];
