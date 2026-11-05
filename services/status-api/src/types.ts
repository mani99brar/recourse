import type { Address, Hex } from 'viem';

export type Chain = 'hedera' | 'arbitrum';
export type ContractName = 'claims' | 'vault' | 'case';

/** One decoded contract event, as kept in the store. */
export interface IndexedEvent {
  /** `${chain}:${tx}:${logIndex}`; the idempotency key. */
  key: string;
  chain: Chain;
  contract: ContractName;
  name: string;
  /** Decoded arguments by name; amounts and ids are bigint. */
  args: Record<string, unknown>;
  tx: Hex;
  logIndex: number;
  /** Unix seconds (Hedera consensus time or Arbitrum block time). */
  time: bigint;
  /** Sortable position inside the chain. */
  order: string;
  /** Arbitrum block number. */
  block?: bigint;
  /** True once at or under the Arbitrum finalized tag. */
  final?: boolean;
}

/** A log as it comes from a source, before decoding. */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  tx: Hex;
  logIndex: number;
  time: bigint;
  order: string;
  block?: bigint;
}

/** One HCS record message after decoding and the payer check. */
export interface HcsRecord {
  topic: string;
  seq: number;
  consensusTimestamp: string;
  payer: string;
  kind: number;
  orderId: Hex;
  hash: Hex;
  cid: string;
}

export interface SourceCursor {
  /** Opaque, comparable position, rendered as text for /health. */
  text: string;
}

export interface SourceStatus {
  /** Rendered cursor. */
  cursor: string;
  /** Unix seconds the source was last read through to its head, or null. */
  indexedThrough: number | null;
  /** Head distance in blocks (Arbitrum only). */
  headDistance: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastOkAt: number | null;
  /** True when the latest poll failed. */
  failing: boolean;
  decodeFailures: number;
}

export type SourceName = 'hedera' | 'arbitrum' | 'hcs';
