// Commits order records: pin the document, then submit one HCS message for it, paid by the
// writer's own account (the agent for every kind but packed, the shop for packed).
//
// Never twice: every step is journaled before it runs, keyed by (orderId, kind). A restart with a
// journaled transaction id first resolves that transaction (receipt, mirror node, topic scan)
// and submits again only once it is certain the earlier one never reached consensus. A second
// document for the same (orderId, kind) is refused (`record_conflict`).

import type { Hex } from 'viem';
import {
  RECORD_KEYS,
  RECORD_WRITERS,
  encodeRecordMsg,
  isHex32,
  recordHash,
  ruleSlotFromDoc,
  type RecordKind,
} from '@recourse/shared';
import type { HcsSubmitter, PreparedMessage } from './hcs.js';
import type { Pinned } from './ipfs.js';
import type { Journal } from './journal.js';
import type { Logger } from './log.js';
import type { MirrorClient } from './mirror.js';
import type { TopicReader } from './topic.js';

/** Record documents stay small so all six fit in one court evidence file with room to spare. */
export const RECORD_DOC_MAX_BYTES = 1536;

export type RecordsErrorCode = 'record_invalid' | 'record_too_large' | 'record_conflict' | 'wrong_writer' | 'submit_failed';

export class RecordsError extends Error {
  constructor(
    readonly code: RecordsErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RecordsError';
  }
}

export type WriterRole = 'agent' | 'shop';

/** The role whose account pays for a kind's message. */
export function writerRoleOf(kind: RecordKind): WriterRole {
  return RECORD_WRITERS[RECORD_KEYS[kind]] === 'shop' ? 'shop' : 'agent';
}

interface RowKey {
  at: string;
  orderId: Hex;
  kind: RecordKind;
  hash: Hex;
}

export type RecordsJournalRow =
  | (RowKey & { type: 'pinned'; cid: string })
  | (RowKey & { type: 'submitting'; cid: string; txId: string; validStart: number; validSeconds: number })
  | (RowKey & { type: 'committed'; cid: string; txId: string; seq: number; consensusAt: string | null; simulated?: true })
  | (RowKey & { type: 'submit_failed'; txId: string; error: string });

export interface Committed {
  orderId: Hex;
  kind: RecordKind;
  seq: number;
  hash: Hex;
  cid: string;
  txId: string;
  consensusAt: string | null;
  /** True when the submitter is an in-memory stand-in: the record is not on Hedera. */
  simulated: boolean;
}

export interface RecordsClientDeps {
  role: WriterRole;
  topicId: string;
  submitter: HcsSubmitter;
  pin: (bytes: Uint8Array) => Promise<Pinned>;
  reader: TopicReader;
  mirror: MirrorClient;
  journal: Journal<RecordsJournalRow>;
  log?: Logger;
  /** Unix seconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Delays before submit retries 1..n, in ms. */
  retryDelaysMs?: number[];
  /** Seconds past a transaction's validity window before it is taken as never landed. */
  expiryGraceSeconds?: number;
  pollMs?: number;
}

interface State {
  hash: Hex;
  cid?: string;
  submitting?: { txId: string; validStart: number; validSeconds: number };
  committed?: Committed;
}

const keyOf = (orderId: Hex, kind: RecordKind) => `${orderId.toLowerCase()}:${kind}`;

export class RecordsClient {
  private readonly states = new Map<string, State>();
  private readonly inFlight = new Map<string, Promise<Committed>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: number[];
  private readonly grace: number;
  private readonly pollMs: number;

  constructor(private readonly deps: RecordsClientDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retryDelaysMs = deps.retryDelaysMs ?? [2000, 4000, 8000];
    this.grace = deps.expiryGraceSeconds ?? 60;
    this.pollMs = deps.pollMs ?? 5000;
    for (const row of deps.journal.rows()) this.apply(row);
  }

  private apply(row: RecordsJournalRow): void {
    const k = keyOf(row.orderId, row.kind);
    const s: State = this.states.get(k) ?? { hash: row.hash };
    if (s.hash !== row.hash) return; // a conflicting row is never written; ignore defensively
    if (row.type === 'pinned') s.cid = row.cid;
    if (row.type === 'submitting') {
      s.cid = row.cid;
      s.submitting = { txId: row.txId, validStart: row.validStart, validSeconds: row.validSeconds };
    }
    if (row.type === 'committed') {
      s.cid = row.cid;
      s.committed = {
        orderId: row.orderId,
        kind: row.kind,
        seq: row.seq,
        hash: row.hash,
        cid: row.cid,
        txId: row.txId,
        consensusAt: row.consensusAt,
        simulated: row.simulated === true,
      };
    }
    this.states.set(k, s);
  }

  private write(row: RecordsJournalRow): void {
    this.deps.journal.append(row);
    this.apply(row);
  }

  /** The committed record for (orderId, kind), if this client has one. */
  committed(orderId: Hex, kind: RecordKind): Committed | undefined {
    return this.states.get(keyOf(orderId, kind))?.committed;
  }

  commitRecord(kind: RecordKind, orderId: Hex, docBytes: Uint8Array): Promise<Committed> {
    const k = keyOf(orderId, kind);
    const running = this.inFlight.get(k);
    if (running) return running;
    const p = this.commitOnce(kind, orderId, docBytes).finally(() => this.inFlight.delete(k));
    this.inFlight.set(k, p);
    return p;
  }

  private async commitOnce(kind: RecordKind, orderId: Hex, docBytes: Uint8Array): Promise<Committed> {
    if (!isHex32(orderId)) throw new RecordsError('record_invalid', 'orderId must be 0x + 64 lowercase hex');
    if (writerRoleOf(kind) !== this.deps.role) {
      throw new RecordsError('wrong_writer', `${RECORD_KEYS[kind]} is written by the ${writerRoleOf(kind)}, not the ${this.deps.role}`);
    }
    if (docBytes.length > RECORD_DOC_MAX_BYTES) {
      throw new RecordsError('record_too_large', `${docBytes.length} bytes, limit ${RECORD_DOC_MAX_BYTES}`);
    }
    const slot = ruleSlotFromDoc(kind, docBytes, orderId);
    if (!slot.ok) throw new RecordsError('record_invalid', slot.error);
    const hash = recordHash(docBytes);
    const k = keyOf(orderId, kind);
    const existing = this.states.get(k);
    if (existing && existing.hash !== hash) {
      throw new RecordsError('record_conflict', `${RECORD_KEYS[kind]} for ${orderId} was already written with another document`);
    }
    if (existing?.committed) return existing.committed;

    // The topic is the record of truth: this payer's first message of the kind for the order counts,
    // whether or not this journal knows about it.
    const ours = (await this.deps.reader.readOrderRecords(orderId)).filter(
      (m) => m.kind === kind && m.payer === this.deps.submitter.payer,
    );
    if (ours.length > 0) {
      const first = ours[0]!;
      if (first.hash !== hash) {
        throw new RecordsError('record_conflict', `${RECORD_KEYS[kind]} for ${orderId} is already on the topic with another document (seq ${first.seq})`);
      }
      const txId = existing?.submitting?.txId ?? '';
      return this.markCommitted(orderId, kind, hash, first.cid, txId, first.seq, first.consensusAt);
    }

    let cid = existing?.cid;
    if (!cid) {
      const pinned = await this.deps.pin(docBytes);
      if (pinned.hash !== hash) throw new RecordsError('record_invalid', 'pinned hash differs from the document hash');
      cid = pinned.cid;
      this.write({ type: 'pinned', at: new Date().toISOString(), orderId, kind, hash, cid });
    }

    // A submission journaled by an earlier run: settle it before preparing another one.
    const pending = this.states.get(k)?.submitting;
    if (pending) {
      const resolved = await this.resolve(orderId, kind, hash, cid, pending);
      if (resolved) return resolved;
    }

    const message = encodeRecordMsg({ cid, hash, kind, orderId });
    const prepared: PreparedMessage = await this.deps.submitter.prepare(this.deps.topicId, message);
    const sub = { txId: prepared.txId, validStart: prepared.validStart, validSeconds: prepared.validSeconds };
    this.write({ type: 'submitting', at: new Date().toISOString(), orderId, kind, hash, cid, ...sub });

    // Retries resend the same signed transaction, so at most one copy can ever reach consensus.
    let lastError = 'no attempt';
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await this.sleep(this.retryDelaysMs[attempt - 1]!);
      try {
        const { seq } = await prepared.send();
        return this.markCommitted(orderId, kind, hash, cid, prepared.txId, seq);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.deps.log?.warn('hcs_submit_failed', { orderId, kind, txId: prepared.txId, attempt, error: lastError.slice(0, 200) });
        const receipt = await this.deps.submitter.receipt(prepared.txId);
        if (receipt.state === 'success') return this.markCommitted(orderId, kind, hash, cid, prepared.txId, receipt.seq);
        if (receipt.state === 'failed') {
          lastError = `transaction failed: ${receipt.status}`;
          break;
        }
      }
    }
    // The submitting row stays: the next call settles this transaction before trying again.
    this.write({ type: 'submit_failed', at: new Date().toISOString(), orderId, kind, hash, txId: prepared.txId, error: lastError.slice(0, 300) });
    throw new RecordsError('submit_failed', `${RECORD_KEYS[kind]} for ${orderId}: ${lastError}`);
  }

  /**
   * Decides what happened to a journaled submission. Returns the commit when it landed, or null once
   * it is certain it never will (failed, or its validity window has passed with nothing on the topic).
   */
  private async resolve(
    orderId: Hex,
    kind: RecordKind,
    hash: Hex,
    cid: string,
    sub: { txId: string; validStart: number; validSeconds: number },
  ): Promise<Committed | null> {
    for (;;) {
      const receipt = await this.deps.submitter.receipt(sub.txId);
      if (receipt.state === 'success') return this.markCommitted(orderId, kind, hash, cid, sub.txId, receipt.seq);
      if (receipt.state === 'failed') return null;
      const onTopic = (await this.deps.reader.readOrderRecords(orderId)).find(
        (m) => m.kind === kind && m.hash === hash && m.payer === this.deps.submitter.payer,
      );
      if (onTopic) return this.markCommitted(orderId, kind, hash, cid, sub.txId, onTopic.seq, onTopic.consensusAt);
      const tx = await this.deps.mirror.transaction(sub.txId).catch(() => null);
      if (tx && tx.result !== 'SUCCESS') return null;
      if (!tx && this.now() > sub.validStart + sub.validSeconds + this.grace) return null;
      await this.sleep(this.pollMs);
    }
  }

  private async markCommitted(
    orderId: Hex,
    kind: RecordKind,
    hash: Hex,
    cid: string,
    txId: string,
    seq: number,
    consensusAt: string | null = null,
  ): Promise<Committed> {
    let at = consensusAt;
    if (at === null) {
      at = (await this.deps.reader.readOrderRecords(orderId).catch(() => [])).find((m) => m.seq === seq)?.consensusAt ?? null;
    }
    const simulated = this.deps.submitter.simulated === true;
    this.write({
      type: 'committed',
      at: new Date().toISOString(),
      orderId,
      kind,
      hash,
      cid,
      txId,
      seq,
      consensusAt: at,
      ...(simulated ? { simulated: true as const } : {}),
    });
    this.deps.log?.info('record_committed', { orderId, kind, seq, txId, ...(simulated ? { simulated } : {}) });
    return this.states.get(keyOf(orderId, kind))!.committed!;
  }
}
