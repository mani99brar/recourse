// HCS message submission. A message is prepared (frozen and signed) first, so its transaction id
// is known and can be journaled before anything reaches the network; `send` submits those exact
// bytes, and `receipt` asks whether a transaction id reached consensus.

import {
  Client,
  PrecheckStatusError,
  PrivateKey,
  Status,
  TopicMessageSubmitTransaction,
  Transaction,
  TransactionId,
  TransactionReceipt,
  TransactionReceiptQuery,
} from '@hiero-ledger/sdk';

export type ReceiptState =
  | { state: 'success'; seq: number }
  | { state: 'failed'; status: string }
  | { state: 'unknown' };

export interface PreparedMessage {
  /** `0.0.N@seconds.nanos`; the payer is the submitter's account. */
  txId: string;
  /** Seconds since the epoch; the transaction cannot reach consensus after validStart + validSeconds. */
  validStart: number;
  validSeconds: number;
  /** Submits the prepared transaction. Safe to call again: at most one copy reaches consensus. */
  send(): Promise<{ seq: number }>;
}

export interface HcsSubmitter {
  /** Account that pays for (and so is the mirror node payer of) every message it submits. */
  readonly payer: string;
  /** True only for in-memory stand-ins; their commits are not on Hedera. */
  readonly simulated?: boolean;
  prepare(topicId: string, message: Uint8Array): Promise<PreparedMessage>;
  receipt(txId: string): Promise<ReceiptState>;
  close(): void;
}

const VALID_SECONDS = 120;

function seqOf(receipt: TransactionReceipt): number {
  const seq = receipt.topicSequenceNumber;
  if (seq === null || seq === undefined) throw new Error('hcs: receipt has no sequence number');
  return Number(seq.toString());
}

/** Submitter backed by the Hedera SDK, paying from `accountId` with an ECDSA key. */
export class SdkHcsSubmitter implements HcsSubmitter {
  private readonly client: Client;

  constructor(
    readonly payer: string,
    key: PrivateKey,
    network: 'testnet' = 'testnet',
  ) {
    if (network !== 'testnet') throw new Error('hcs: only testnet is supported');
    this.client = Client.forTestnet().setOperator(payer, key);
  }

  /** Builds the submitter from 32 key bytes, zeroing them once the SDK key exists. */
  static fromKeyBytes(payer: string, keyBytes: Uint8Array): SdkHcsSubmitter {
    let key: PrivateKey;
    try {
      key = PrivateKey.fromBytesECDSA(keyBytes);
    } finally {
      keyBytes.fill(0);
    }
    return new SdkHcsSubmitter(payer, key);
  }

  async prepare(topicId: string, message: Uint8Array): Promise<PreparedMessage> {
    const txId = TransactionId.generate(this.payer);
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(message)
      .setTransactionId(txId)
      .setTransactionValidDuration(VALID_SECONDS)
      .freezeWith(this.client);
    const signed = await tx.signWithOperator(this.client);
    const bytes = signed.toBytes();
    const validStart = txId.validStart?.seconds?.toNumber() ?? Math.floor(Date.now() / 1000);
    return {
      txId: txId.toString(),
      validStart,
      validSeconds: VALID_SECONDS,
      // Each call submits the same signed bytes again. A copy that already reached consensus is
      // rejected as DUPLICATE_TRANSACTION, and the original receipt answers instead.
      send: async () => {
        try {
          const response = await Transaction.fromBytes(bytes).execute(this.client);
          return { seq: seqOf(await response.getReceipt(this.client)) };
        } catch (error) {
          if (error instanceof PrecheckStatusError && error.status === Status.DuplicateTransaction) {
            const receipt = await new TransactionReceiptQuery().setTransactionId(txId).execute(this.client);
            return { seq: seqOf(receipt) };
          }
          throw error;
        }
      },
    };
  }

  async receipt(txId: string): Promise<ReceiptState> {
    try {
      const receipt = await new TransactionReceiptQuery()
        .setTransactionId(TransactionId.fromString(txId))
        .setValidateStatus(false)
        .execute(this.client);
      if (receipt.status === Status.Success) {
        const seq = receipt.topicSequenceNumber;
        return seq === null || seq === undefined ? { state: 'unknown' } : { state: 'success', seq: Number(seq.toString()) };
      }
      if (receipt.status === Status.ReceiptNotFound || receipt.status === Status.Unknown) return { state: 'unknown' };
      return { state: 'failed', status: receipt.status.toString() };
    } catch {
      return { state: 'unknown' };
    }
  }

  close(): void {
    this.client.close();
  }
}
