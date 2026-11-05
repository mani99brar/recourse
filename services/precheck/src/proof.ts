// Per-slot proof of an order record. For each of the six slots the record used is the one the
// claim's refs name if it passes every check, else the earliest message the topic index holds for
// the order and kind that passes them. A slot ends as held, absent or rejected; anything that is
// only a failure to look (mirror or gateway trouble, a message not yet visible) is a retry and is
// never turned into an absence.

import { TransientError, tsSeconds, type MirrorClient } from '@recourse/keeper';
import {
  ZERO_HASH,
  hcsWritersFor,
  ruleSlotFromDoc,
  sha256,
  type Parties,
  type RecordKind,
  type RecordRefs,
} from '@recourse/shared';
import type { Hex } from 'viem';
import type { Clock } from './clock.js';
import type { DocStore } from './docs.js';
import type { Reason, SlotOutcome } from './slots.js';
import { toIndexed, type IndexedMessage, type TopicIndex } from './topicIndex.js';

export interface ProofClaim {
  claimId: Hex;
  orderId: Hex;
  /** Unix seconds (block timestamp of the filing). */
  filedAt: bigint;
  refs: RecordRefs;
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
  | { ok: false; reason: Reason; seq: bigint; hcsHash?: Hex; cid?: string };

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
  // 2 decodes (a chunked message never does)
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
  // 6 payer
  const payer = await payerOf(msg, ports);
  if (!hcsWritersFor(ports.parties, kind).has(payer)) return { ok: false, reason: 'payer_mismatch', ...known };
  // 7 consensus time, whole seconds
  if (tsSeconds(msg.consensusAt) > claim.filedAt) return { ok: false, reason: 'after_filing', ...known };
  // 8 document bytes
  const suspect = ports.suspects.get(f.cid);
  const bytes = await ports.docs.fetch(f.cid, suspect === undefined ? undefined : { fresh: true });
  if (bytes === null) throw new TransientError(`document ${f.cid} is not available yet`);
  const actual = sha256(bytes);
  if (actual !== f.hash) {
    if (suspect === actual) return { ok: false, reason: 'bytes_mismatch', ...known };
    ports.suspects.set(f.cid, actual);
    throw new TransientError(`document ${f.cid} does not match its hash; fetching again`);
  }
  ports.suspects.delete(f.cid);
  // 9 the document itself
  if (!ruleSlotFromDoc(kind, bytes, claim.orderId).ok) return { ok: false, reason: 'doc_invalid', ...known };
  return { ok: true, held: { ...known, payer, consensusAt: msg.consensusAt, bytes } };
}

function rejected(kind: RecordKind, v: Extract<Verdict, { ok: false }>): SlotOutcome {
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

    let refsVerdict: Verdict | undefined;
    if (refsNamed) {
      refsVerdict = await check({ from: 'refs', hash: named }, refsSeq, kind, claim, ports);
      if (refsVerdict.ok) return { final: true, slot: { kind, outcome: 'held', ...refsVerdict.held } };
    }

    // Index candidates after the filing can never pass; leaving them out keeps the document stable.
    const list = ports.index.candidates(claim.orderId, kind).filter((m) => tsSeconds(m.consensusAt) <= claim.filedAt);
    let firstReject: Extract<Verdict, { ok: false }> | undefined;
    for (const m of list) {
      const v = await check({ from: 'index' }, m.seq, kind, claim, ports);
      if (v.ok) {
        const refs =
          refsVerdict !== undefined && !refsVerdict.ok
            ? { seq: refsSeq, hash: named, reason: refsVerdict.reason }
            : { seq: 0n, hash: ZERO_HASH, reason: 'not_named' as const };
        return { final: true, slot: { kind, outcome: 'held', ...v.held, refs } };
      }
      firstReject ??= v;
    }

    // Nothing passed. That is only final once the index has read every message up to the filing.
    if (!ports.index.readThrough(claim.filedAt, ports.quietS)) {
      return { final: false, why: `slot ${kind}: the topic index has not read through the filing yet` };
    }
    if (refsVerdict !== undefined && !refsVerdict.ok) return { final: true, slot: rejected(kind, refsVerdict) };
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
