// Keeper types: the chain port the machine talks through, the events it consumes and the
// per-claim record it keeps. All times are unix seconds (chain time for milestones).

import type { Address, Hex } from 'viem';
import type { BridgeMode, CaseView, Claim, ExecutionState } from '@recourse/shared';
import type { JournalRecord } from './journal.js';

export type Chain = 'hedera' | 'arbitrum';

/** A decoded contract event. `args` holds viem-decoded values (bigints, hex, addresses). */
export interface ChainEvent {
  chain: Chain;
  /** Contract the event came from: claims, vault, case, core, kit, evidence. */
  source: string;
  name: string;
  args: Record<string, unknown>;
  tx: Hex;
  logIndex: number;
  /** Chain time of the block or consensus timestamp, seconds. */
  time: number;
  /** Arbitrum block number, or the Hedera consensus timestamp text. */
  position: string;
}

export function eventKey(e: Pick<ChainEvent, 'chain' | 'tx' | 'logIndex'>): string {
  return `${e.chain}:${e.tx.toLowerCase()}:${e.logIndex}`;
}

export interface ClaimsParams {
  contestWindow: number;
  claimTimeout: number;
  resendGap: number;
  maxSends: number;
}

export interface CaseParams {
  caseDeadline: number;
  maxOpenCases: number;
  resendGap: number;
  maxSends: number;
  /**
   * The case contract's own claim timeout (`claimTimeout()`, fixed at deploy): a case expires at
   * the payload's filedAt + this, and from then on anyone may `markStale` it.
   */
  claimTimeout: number;
}

export interface DisputeInfo {
  courtId: bigint;
  /** 0 evidence, 1 commit, 2 vote, 3 appeal, 4 execution. */
  period: number;
  ruled: boolean;
  lastPeriodChange: number;
  /** Seconds per period for the dispute's court. */
  timesPerPeriod: readonly [number, number, number, number];
}

export interface RulingRead {
  ruling: bigint;
  tied: boolean;
  overridden: boolean;
}

export interface SortitionRead {
  /** 0 staking, 1 generating, 2 drawing. */
  phase: number;
  lastPhaseChange: number;
  minStakingTime: number;
  maxDrawingTime: number;
  disputesWithoutJurors: bigint;
}

export type ContractName = 'claims' | 'case' | 'core' | 'sortition' | 'evidence';

/** A call the keeper wants made. The adapter encodes it and picks the key for the chain. */
export interface KeeperCall {
  chain: Chain;
  contract: ContractName;
  fn: string;
  args: readonly unknown[];
  /** Native value in wei (Arbitrum) or weibar (Hedera). */
  value?: bigint;
  claimId?: Hex;
}

/** What came of a call, normalised across the real adapter and the fake. */
export type CallResult =
  | { kind: 'ok'; hash: Hex }
  /** Sent; no receipt yet. The open intent is settled on a later tick. */
  | { kind: 'pending'; hash: Hex }
  /** Another call on the same key is still open; try again next tick. */
  | { kind: 'busy' }
  /** Dry run: printed, not sent. */
  | { kind: 'dry' }
  /** Simulation or the mined transaction reverted. `error` is the decoded custom error name. */
  | { kind: 'reverted'; error?: string; args?: readonly unknown[]; hash?: Hex; message?: string };

/** Everything the machine needs from the two chains. */
export interface Chains {
  /**
   * Restores sender state from the replayed journal: the keeper hands over the intents that have
   * no result yet (results already applied). Called once at start, before any read or send.
   */
  load(records: readonly JournalRecord[]): void;
  /** Contract address of the Arbitrum case contract and the Arbitrum chain id (for external ids). */
  readonly caseAddress: Address;
  readonly arbChainId: number;
  /** Ops addresses (evidence must come from ours). */
  readonly opsArb: Address;
  readonly opsHedera: Address;

  /** New Hedera events since the last commit, oldest first (may repeat after a restart). */
  pollHedera(): Promise<ChainEvent[]>;
  commitHedera(events: readonly ChainEvent[]): void;
  /**
   * New Arbitrum events. `disputeIds` and `externalIds` narrow the Kleros reads (Draw,
   * Contribution, ChoiceFunded, Evidence) to our disputes; `onCaseEvents` lets the caller learn
   * new dispute ids from a block range before its Kleros logs are read.
   */
  pollArbitrum(filter: {
    disputeIds: () => readonly bigint[];
    externalIds: () => readonly bigint[];
    onCaseEvents: (events: readonly ChainEvent[]) => void;
  }): Promise<ChainEvent[]>;
  commitArbitrum(events: readonly ChainEvent[]): void;

  getClaim(claimId: Hex): Promise<Claim>;
  claimsParams(): Promise<ClaimsParams>;
  bridgeMode(): Promise<BridgeMode>;
  caseOf(claimId: Hex): Promise<CaseView>;
  caseParams(): Promise<CaseParams>;
  feePool(): Promise<bigint>;
  costNow(): Promise<bigint>;
  openCases(): Promise<number>;
  /** Execution state of a CCIP message on the destination chain's OffRamp. */
  execState(destination: Chain, messageId: Hex): Promise<ExecutionState>;
  dispute(disputeId: bigint): Promise<DisputeInfo>;
  currentRuling(disputeId: bigint): Promise<RulingRead>;
  sortition(): Promise<SortitionRead>;
  creditOf(account: Address): Promise<bigint>;
  /** LINK fee to relay the ruling now, and the native fee. */
  quoteRelay(claimId: Hex): Promise<{ link: bigint; native: bigint }>;
  /** Balances for the funding alerts. */
  levels(): Promise<Levels>;
  /** Seconds one round of the court our cases go to takes: the sum of its four periods. */
  courtRoundS?(): Promise<number>;
  /**
   * What sending this claim to court would cost now, in what the claims contract pays CCIP fees
   * with: weibar when it pays in HBAR (`native`), LINK wei otherwise. 0 for an unknown claim.
   */
  quoteSend?(claimId: Hex): Promise<{ native: boolean; amount: bigint }>;
  /** Seconds the Hedera event source trails consensus time (mirror node lag); absent locally. */
  hederaLagS?(): Promise<number>;

  send(call: KeeperCall): Promise<CallResult>;
  /**
   * Settles calls left open by a timeout or a restart and returns the ones it settled.
   * `rebroadcast` says whether an intent the node no longer knows may be broadcast again now
   * (false while paused or inside a send-pause window: receipts are still read).
   */
  resolveOpen(opts?: { rebroadcast?: (chain: Chain, call: string) => boolean }): Promise<ResolvedCall[] | void>;
  /** True when a call on this chain is open (signed, unresolved) for the claim and function. */
  hasOpen(chain: Chain, fn: string, claimId: Hex): boolean;
  /** Open intents with their age and broadcast trouble; absent where nothing is signed. */
  intentStatus?(): OpenIntentStatus[];
  /**
   * The open intent records of both senders, exactly as journaled, for a compacted journal.
   * Without it the keeper never compacts (it would lose transactions in flight).
   */
  openIntentRecords?(): JournalRecord[];
}

/** A call that was left open and has now been settled. */
/** Balances the funding alerts compare against their floors. */
export interface Levels {
  /** eth_getBalance of the ops keys: weibar on Hedera (10^18 per HBAR), wei on Arbitrum. */
  opsHederaWeibar: bigint;
  opsArbWei: bigint;
  /** LINK (wei) held by the claims and the case contracts. */
  claimsLink: bigint;
  caseLink: bigint;
  /** What the claims contract pays CCIP fees in: its LINK token, or the zero address for HBAR. */
  claimsFeeToken?: Address;
  /** HBAR the claims contract holds for fees paid natively, in weibar. */
  claimsNativeWeibar?: bigint;
}

export interface ResolvedCall {
  chain: Chain;
  call: string;
  claimId?: Hex;
  hash: Hex;
  outcome: 'success' | 'reverted' | 'superseded' | 'dropped' | 'pending';
}

export interface OpenIntentStatus {
  chain: Chain;
  call: string;
  claimId?: Hex;
  hash: Hex;
  nonce: number;
  ageS: number;
  rejections: number;
  /** 'funds' when the node refused it because the key cannot pay. */
  reason?: string;
  lastError?: string;
}

/** Keeper-side phase of a claim. Terminal phases mirror the Hedera end states. */
export const PHASES = [
  'Filed',
  'PreChecked',
  'Contested',
  'Sent',
  'Delivered',
  'Opened',
  'Watching',
  'RefilePending',
  'RuledArb',
  'Relayed',
  'RuledHedera',
  'Stale',
  'Settled',
  'Closed',
  'Expired',
] as const;
export type Phase = (typeof PHASES)[number];

export const TERMINAL: readonly Phase[] = ['Settled', 'Closed', 'Expired'];

export interface BridgeMsg {
  messageId: Hex;
  sendNo: number;
  sentAt: number;
  /** Last execution state read, and when state 2 was first seen. */
  state?: ExecutionState;
  successSeenAt?: number;
}

export interface CourtAttempt {
  attempt: 1 | 2;
  disputeId: string;
  /** Evidence group id, decimal. */
  externalId: string;
  openedAt: number;
  drawSeen?: boolean;
  evidenceAt?: number;
  evidenceTx?: Hex;
}

/** The keeper's record of one claim. JSON-safe: big numbers are decimal strings. */
export interface KeeperClaim {
  claimId: Hex;
  orderId?: Hex;
  shop?: Address;
  platform?: Address;
  filedAt?: number;
  preCheckedAt?: number;
  contestedAt?: number;
  outbound: BridgeMsg[];
  inbound: BridgeMsg[];
  /** `ClaimReceived` on Arbitrum: the exact payload bytes kept for openCase and refile. */
  received?: { messageId: Hex; payload: Hex; at: number };
  /** Outbound delivery proven (OffRamp state 2 with our receive event, or a relay). */
  deliveredAt?: number;
  attempts: CourtAttempt[];
  refileNeededAt?: number;
  rulingFinal?: { disputeId: string; ruling: number; attempts: number; at: number };
  rulingReceivedAt?: number;
  rulingIgnored?: { reason: number; at: number; messageId?: Hex }[];
  staleAt?: number;
  /** The case's expiresAt as the case contract reported it in a NotExpired revert; wins over the local sum. */
  caseExpiresAt?: number;
  terminal?: 'Settled' | 'Closed' | 'Expired';
  terminalAt?: number;
  /** Per call: tries so far and the time of the last one (s). */
  tries: Record<string, { count: number; lastAt: number }>;
  /** Set by the keeper itself (exhausted retries, failed expiry, evidence that cannot be built). */
  autoHold?: { reason: string; atMs: number };
  /** One-shot markers: nudges sent, once-only alerts. */
  done: string[];
  /**
   * Built evidence per attempt, by SHA-256. The text itself is journaled once as its own record
   * (see ClaimBook.evidenceText) so state snapshots stay small.
   */
  evidence?: Record<string, { sha256: Hex }>;
  /** Last read of the dispute's ruling. */
  lastRuling?: { attempt: number; ruling: string; tied: boolean; overridden: boolean; at: number };
  lastError?: string;
}

export function newClaim(claimId: Hex): KeeperClaim {
  return { claimId: claimId.toLowerCase() as Hex, outbound: [], inbound: [], attempts: [], tries: {}, done: [] };
}
