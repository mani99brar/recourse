// Per-slot proof of an order record. For each of the six slots the record used is the one the
// claim's refs name if it passes every check, else the earliest message the topic index holds for
// the order and kind that passes them. A slot ends as held, absent or rejected. A failure to look
// at the mirror (lag, errors, a message not yet visible) is a retry and is never turned into an
// absence. A record document that cannot be read is a retry only for a bounded time: once the
// claim is `docWaitS` past its filing (and the document has failed for at least DOC_RETRY_MIN_MS),
// it is rejected as doc_unavailable, so a writer cannot hold a claim open by pointing at a document
// nobody can fetch. A document over RECORD_DOC_MAX_BYTES is rejected at once (its size is fixed by
// its hash), so the court evidence always has room for every held record.

import { TransientError, tsSeconds, type MirrorClient } from '@recourse/keeper';
import {
  RECORD_DOC_MAX_BYTES,
  ZERO_HASH,
  checkRecordSignature,
  orderWritersFor,
  rawCidOfHash,
  recordSignersFor,
  ruleSlotFromDoc,
  sha256,
  type Parties,
  type RecordKind,
  type RecordRefs,
} from '@recourse/shared';
import type { Hex } from 'viem';
import type { Clock } from './clock.js';
import { DocTooLarge, type DocStore } from './docs.js';
import type { Reason, SlotOutcome } from './slots.js';
import { toIndexed, type IndexedMessage, type TopicIndex } from './topicIndex.js';

/** Default for how long after the filing an unreadable record document is waited for: one hour, well under claimTimeout (18 h). */
export const DOC_WAIT_S = 3600;
/** A document must have failed to read for at least this long before it counts as unavailable, so a service that was down does not reject on its first look. */
export const DOC_RETRY_MIN_MS = 10 * 60_000;

export interface ProofClaim {
  claimId: Hex;
  orderId: Hex;
  /** Unix seconds (block timestamp of the filing). */
  filedAt: bigint;
  refs: RecordRefs;
  /** The claim's platform and shop (from ClaimFiled), by EVM address: only their own writers count. */
  platform: string;
  shop: string;
}

export interface ProofPorts {
  index: TopicIndex;
  mirror: Pick<MirrorClient, 'topicMessage' | 'transactionAccountAt'>;
  docs: DocStore;
  parties: Parties;
  /** Number of the configured records topic (the N of its id). */
  topicNum: bigint;
  quietS: number;
  clock: Clock;
  /**
   * Hash of document bytes that failed their check once, by CID. A second fetch that returns the
   * same bytes makes the mismatch final. Kept by the caller for the life of the claim.
   */
  suspects: Map<string, Hex>;
  /** First time (clock ms) each document, by CID, failed to read. Kept by the caller for the life of the claim. */
  unread: Map<string, number>;
  /** Seconds after the filing from which a document that still cannot be read is rejected (doc_unavailable). */
  docWaitS: number;
}

/** No payer could be found for a message from any of the three sources. */
export class PayerUnresolved extends TransientError {
  constructor(readonly seq: bigint) {
    super(`no payer found for topic message ${seq}`);
    this.name = 'PayerUnresolved';
  }
}

export type SlotProof = { final: true; slot: SlotOutcome } | { final: false; why: string; payerUnresolved?: bigint };

export type ClaimProof =
  | { final: true; slots: SlotOutcome[] }
  | { final: false; why: string[]; payerUnresolved: bigint[] };

type Verdict =
  | { ok: true; held: { seq: bigint; hcsHash: Hex; cid: string; payer: string; consensusAt: string; bytes: Uint8Array } }
  | { ok: false; reason: Reason; seq: bigint; hcsHash?: Hex; cid?: string }
  /** The document could not be read yet; not final until the wait is over. */
  | { ok: 'pending'; why: string };
type Rejection = Extract<Verdict, { ok: false }>;

async function payerOf(msg: IndexedMessage, ports: ProofPorts): Promise<string> {
  if (msg.payer !== undefined) return msg.payer;
  if (msg.txAccount !== undefined) return msg.txAccount;
  const account = await ports.mirror.transactionAccountAt(msg.consensusAt);
  if (account === null) throw new PayerUnresolved(msg.seq);
  return account;
}

async function messageAt(seq: bigint, ports: ProofPorts): Promise<IndexedMessage> {
  const known = ports.index.get(seq);
  if (known !== undefined) return known;
  const m = await ports.mirror.topicMessage(ports.index.topicId, seq);
  if (m === null) throw new TransientError(`topic message ${seq} is not on the mirror yet`);
  return toIndexed(m);
}

/**
 * A document that could not be read: pending until the claim is `docWaitS` past its filing and the
 * document has failed for DOC_RETRY_MIN_MS, then rejected as doc_unavailable.
 */
function unreadable(cid: string, why: string, known: Omit<Rejection, 'ok' | 'reason'>, claim: ProofClaim, ports: ProofPorts): Verdict {
  const now = ports.clock.now();
  const first = ports.unread.get(cid) ?? now;
  ports.unread.set(cid, first);
  const waitedOut = now >= Number(claim.filedAt + BigInt(ports.docWaitS)) * 1000 && now - first >= DOC_RETRY_MIN_MS;
  return waitedOut ? { ok: false, reason: 'doc_unavailable', ...known } : { ok: 'pending', why };
}

/** Runs the checks in their fixed order against one candidate message. */
async function check(
  source: { from: 'refs'; hash: Hex } | { from: 'index' },
  seq: bigint,
  kind: RecordKind,
  claim: ProofClaim,
  ports: ProofPorts,
): Promise<Verdict> {
  // 1 topic
  if (source.from === 'refs' && claim.refs.topicNum !== ports.topicNum) return { ok: false, reason: 'topic_mismatch', seq };
  // A refs seq of 0 names no message at all.
  if (seq <= 0n) return { ok: false, reason: 'doc_invalid', seq };
  const msg = await messageAt(seq, ports);
  // 2 decodes (a chunked message never does; nor does one whose cid is not the CID of its hash)
  if (!msg.decoded.ok) return { ok: false, reason: 'doc_invalid', seq };
  const f = msg.decoded.value;
  const known = { seq, hcsHash: f.hash, cid: f.cid };
  // 3 kind, 4 order
  if (f.kind !== kind) return { ok: false, reason: 'kind_mismatch', ...known };
  if (f.orderId.toLowerCase() !== claim.orderId.toLowerCase()) return { ok: false, reason: 'order_mismatch', ...known };
  // 5 hash named by the refs
  if (source.from === 'refs' && f.hash.toLowerCase() !== source.hash.toLowerCase()) {
    return { ok: false, reason: 'hash_mismatch_hcs', ...known };
  }
  // 6 payer: a writer of this claim's own platform (or, for packed, its own shop)
  const payer = await payerOf(msg, ports);
  if (!orderWritersFor(ports.parties, kind, claim).has(payer)) return { ok: false, reason: 'payer_mismatch', ...known };
  // 7 consensus time, whole seconds
  if (tsSeconds(msg.consensusAt) > claim.filedAt) return { ok: false, reason: 'after_filing', ...known };
  // 8 document bytes, read by the CID of the hash (which the message's cid always is)
  const cid = rawCidOfHash(f.hash);
  const suspect = ports.suspects.get(cid);
  let bytes: Uint8Array | null;
  try {
    bytes = await ports.docs.fetch(cid, suspect === undefined ? undefined : { fresh: true });
  } catch (err) {
    if (err instanceof DocTooLarge) return { ok: false, reason: 'doc_too_large', ...known };
    if (err instanceof TransientError) return unreadable(cid, err.message, known, claim, ports);
    throw err;
  }
  if (bytes === null) return unreadable(cid, `document ${cid} is not available yet`, known, claim, ports);
  const actual = sha256(bytes);
  if (actual !== f.hash) {
    if (suspect === actual) return { ok: false, reason: 'bytes_mismatch', ...known };
    ports.suspects.set(cid, actual);
    return unreadable(cid, `document ${cid} does not match its hash; fetching again`, known, claim, ports);
  }
  ports.suspects.delete(cid);
  ports.unread.delete(cid);
  // 9 size: every held record must fit in the court evidence
  if (bytes.length > RECORD_DOC_MAX_BYTES) return { ok: false, reason: 'doc_too_large', ...known };
  // 10 the document itself
  if (!ruleSlotFromDoc(kind, bytes, claim.orderId).ok) return { ok: false, reason: 'doc_invalid', ...known };
  // 11 signatures: a buyer approval and the arrived record by a buyer of the party map, a mandate approval by the agent that wrote it
  if (!(await checkRecordSignature(kind, bytes, recordSignersFor(ports.parties, payer))).ok) {
    return { ok: false, reason: 'signature_invalid', ...known };
  }
  return { ok: true, held: { ...known, payer, consensusAt: msg.consensusAt, bytes } };
}

function rejected(kind: RecordKind, v: Rejection): SlotOutcome {
  const out: SlotOutcome = { kind, outcome: 'rejected', reason: v.reason, seq: v.seq };
  if (v.hcsHash !== undefined) out.hcsHash = v.hcsHash;
  if (v.cid !== undefined) out.cid = v.cid;
  return out;
}

/** Proves one slot. Throws only for faults that are not retryable (a bug). */
export async function proveSlot(kind: RecordKind, claim: ProofClaim, ports: ProofPorts): Promise<SlotProof> {
  try {
    const named = claim.refs.hashes[kind];
    const refsSeq = claim.refs.seq[kind];
    const refsNamed = named.toLowerCase() !== ZERO_HASH;

    let refsVerdict: Rejection | undefined;
    if (refsNamed) {
      const v = await check({ from: 'refs', hash: named }, refsSeq, kind, claim, ports);
      if (v.ok === true) return { final: true, slot: { kind, outcome: 'held', ...v.held } };
      // The named record wins if it passes, so nothing else can be chosen while it may still.
      if (v.ok === 'pending') return { final: false, why: `slot ${kind}: ${v.why}` };
      refsVerdict = v;
    }

    // Read the index's progress and its candidates together (no await between): the list is
    // complete exactly when `complete` is true, even if the index grows while documents are fetched.
    const complete = ports.index.readThrough(claim.filedAt, ports.quietS);
    // Index candidates after the filing can never pass; leaving them out keeps the document stable.
    const list = ports.index.candidates(claim.orderId, kind).filter((m) => tsSeconds(m.consensusAt) <= claim.filedAt);
    let firstReject: Rejection | undefined;
    for (const m of list) {
      const v = await check({ from: 'index' }, m.seq, kind, claim, ports);
      if (v.ok === true) {
        const refs =
          refsVerdict !== undefined
            ? { seq: refsSeq, hash: named, reason: refsVerdict.reason }
            : { seq: 0n, hash: ZERO_HASH, reason: 'not_named' as const };
        return { final: true, slot: { kind, outcome: 'held', ...v.held, refs } };
      }
      // The earliest record that passes is used, so a later one cannot be chosen while this one may still pass.
      if (v.ok === 'pending') return { final: false, why: `slot ${kind}: ${v.why}` };
      firstReject ??= v;
    }

    // Nothing passed. That is only final once the index has read every message up to the filing.
    if (!complete) {
      return { final: false, why: `slot ${kind}: the topic index has not read through the filing yet` };
    }
    if (refsVerdict !== undefined) return { final: true, slot: rejected(kind, refsVerdict) };
    if (firstReject !== undefined) return { final: true, slot: rejected(kind, firstReject) };
    return { final: true, slot: { kind, outcome: 'absent' } };
  } catch (err) {
    if (err instanceof PayerUnresolved) return { final: false, why: err.message, payerUnresolved: err.seq };
    if (err instanceof TransientError) return { final: false, why: `slot ${kind}: ${err.message}` };
    throw err;
  }
}

const KINDS = [0, 1, 2, 3, 4, 5] as const satisfies readonly RecordKind[];

/** Proves all six slots. Final only when every slot is. */
export async function proveClaim(claim: ProofClaim, ports: ProofPorts): Promise<ClaimProof> {
  const slots: SlotOutcome[] = [];
  const why: string[] = [];
  const payerUnresolved: bigint[] = [];
  for (const kind of KINDS) {
    const p = await proveSlot(kind, claim, ports);
    if (p.final) slots.push(p.slot);
    else {
      why.push(p.why);
      if (p.payerUnresolved !== undefined) payerUnresolved.push(p.payerUnresolved);
    }
  }
  return why.length === 0 ? { final: true, slots } : { final: false, why, payerUnresolved };
}
