// Evidence format v1: the string posted to the Kleros EvidenceModule for one court attempt.
//
// The court reads an evidence string as a JSON object {name, description, fileURI?} and renders
// `description` as Markdown inline. So the evidence is the content itself: every record document
// the pre-check used, byte for byte, with its SHA-256, plus the pre-check document. A juror can
// recompute each hash from what is shown. Nothing here fetches; the builder is pure.

import {
  RECORD_KEYS,
  RECORD_LETTERS,
  ZERO_HASH,
  recordHash,
  type ClaimToCourt,
  type RecordKey,
  type RecordKind,
} from '@recourse/shared';
import type { Hex } from 'viem';

export const EVIDENCE_VERSION = '1';
/** Largest evidence string accepted, in UTF-8 bytes. */
export const EVIDENCE_MAX_BYTES = 16 * 1024;

export interface EvidenceRecordDoc {
  kind: RecordKind;
  /** Exact document bytes, as pinned. */
  bytes: Uint8Array;
  cid?: string;
  hcsSeq?: bigint;
}

export interface EvidenceInput {
  /** The decoded ClaimToCourt payload of the case. */
  claim: ClaimToCourt;
  attempt: 1 | 2;
  /** Evidence group id the string is filed under. */
  externalId: bigint;
  /** Documents for the slots the pre-check held. Documents for other slots are ignored. */
  records: readonly EvidenceRecordDoc[];
  /** The pre-check result document; its SHA-256 must equal the payload's packHash. */
  precheck: { bytes: Uint8Array; cid?: string };
  /** Optional line shown first, in plain text (for example, to mark a trial case). */
  notice?: string;
  /** Optional `/ipfs/<cid>` of a pinned copy of this bundle, set as `fileURI`. */
  fileURI?: string;
}

export type SlotState = 'held' | 'fromIndex' | 'absent' | 'rejected';

export interface EvidenceSlot {
  kind: RecordKind;
  key: RecordKey;
  state: SlotState;
  sha256?: Hex;
  cid?: string;
  hcsSeq?: string;
  reason?: string;
}

export interface EvidenceBundle {
  version: typeof EVIDENCE_VERSION;
  claimId: Hex;
  attempt: 1 | 2;
  externalId: bigint;
  /** The exact string to pass to `EvidenceModule.submitEvidence(externalId, evidence)`. */
  evidence: string;
  /** UTF-8 length of `evidence`. */
  byteLength: number;
  /** SHA-256 of the UTF-8 bytes of `evidence`. */
  sha256: Hex;
  slots: EvidenceSlot[];
}

/** A document's SHA-256 does not match the hash it must have. `kind` is a record key or "precheck". */
export class EvidenceHashMismatch extends Error {
  constructor(
    readonly kind: RecordKey | 'precheck',
    detail: string,
  ) {
    super(`EvidenceHashMismatch(${kind}): ${detail}`);
    this.name = 'EvidenceHashMismatch';
  }
}

export class EvidenceTooLarge extends Error {
  constructor(
    readonly size: number,
    readonly max: number,
  ) {
    super(`EvidenceTooLarge: ${size} bytes, limit ${max}`);
    this.name = 'EvidenceTooLarge';
  }
}

/** The pre-check document is not in the shape the builder reads. */
export class EvidenceInputError extends Error {
  constructor(detail: string) {
    super(`EvidenceInputError: ${detail}`);
    this.name = 'EvidenceInputError';
  }
}

interface PrecheckSlot {
  outcome: 'held' | 'absent' | 'rejected';
  hcsHash?: Hex;
  cid?: string;
  seq?: string;
  reason?: string;
}

interface PrecheckView {
  gap?: string;
  answer?: string;
  reasonKey?: string;
  step?: string;
  flagged: string[];
  slots: PrecheckSlot[];
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Reads the fields of the pre-check document this format uses. */
function readPrecheck(bytes: Uint8Array): PrecheckView {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new EvidenceInputError('pre-check document is not UTF-8 JSON');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new EvidenceInputError('pre-check document is not an object');
  const d = doc as Record<string, unknown>;
  const records = d.records;
  if (!Array.isArray(records) || records.length !== 6) throw new EvidenceInputError('pre-check records must list 6 slots');
  const slots = records.map((r, k): PrecheckSlot => {
    if (typeof r !== 'object' || r === null) throw new EvidenceInputError(`pre-check slot ${k} is not an object`);
    const s = r as Record<string, unknown>;
    const outcome = s.outcome;
    if (outcome !== 'held' && outcome !== 'absent' && outcome !== 'rejected') {
      throw new EvidenceInputError(`pre-check slot ${k} has outcome ${String(outcome)}`);
    }
    const hcsHash = str(s.hcsHash);
    if (outcome === 'held' && (hcsHash === undefined || !HEX32.test(hcsHash))) {
      throw new EvidenceInputError(`pre-check slot ${k} is held without a 32-byte hcsHash`);
    }
    return { outcome, hcsHash: hcsHash as Hex | undefined, cid: str(s.cid), seq: str(s.seq), reason: str(s.reason) };
  });
  const result = (typeof d.result === 'object' && d.result !== null ? d.result : {}) as Record<string, unknown>;
  const cells = Array.isArray(result.flaggedCells) ? result.flaggedCells : [];
  const flagged = cells
    .map((c) => (typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : {}))
    .map((c) => `${str(c.record) ?? '?'}.${str(c.attribute) ?? '?'}`);
  return {
    gap: str(d.gap) ?? str(result.gap),
    answer: str(d.answer) ?? str(result.answer),
    reasonKey: str(d.reasonKey) ?? str(result.reasonKey),
    step: str(result.step),
    flagged,
    slots,
  };
}

/** A Markdown code fence longer than any backtick run inside `text`, so the text cannot close it. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function block(text: string): string {
  const f = fenceFor(text);
  return `${f}json\n${text}\n${f}`;
}

const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Builds the evidence for one court attempt. Checks, in order: the pre-check document against the
 * payload's packHash, then each held record against the pre-check's hcsHash for that slot. Throws
 * `EvidenceHashMismatch` on any mismatch and `EvidenceTooLarge` above the byte cap. Same input, same bytes.
 */
export function buildEvidence(input: EvidenceInput): EvidenceBundle {
  const { claim, attempt, externalId } = input;
  const packHash = recordHash(input.precheck.bytes);
  if (packHash.toLowerCase() !== claim.packHash.toLowerCase()) {
    throw new EvidenceHashMismatch('precheck', `document hash ${packHash} is not the payload packHash ${claim.packHash}`);
  }
  const pre = readPrecheck(input.precheck.bytes);

  const slots: EvidenceSlot[] = [];
  const sections: string[] = [];
  for (let k = 0; k < 6; k++) {
    const kind = k as RecordKind;
    const key = RECORD_KEYS[k]!;
    const heading = `### ${k + 1}. ${key} (${RECORD_LETTERS[k]})`;
    const ps = pre.slots[k]!;
    if (ps.outcome !== 'held') {
      const slot: EvidenceSlot = { kind, key, state: ps.outcome };
      if (ps.reason !== undefined) slot.reason = ps.reason;
      slots.push(slot);
      sections.push(
        ps.outcome === 'absent'
          ? `${heading}: absent\n\nNo record of this kind was found for this order. It counts as missing.`
          : `${heading}: rejected\n\nA record was found but failed the pre-check's checks${ps.reason ? ` (reason: ${ps.reason})` : ''}. It counts as missing.`,
      );
      continue;
    }
    const doc = input.records.find((r) => r.kind === kind);
    if (doc === undefined) throw new EvidenceHashMismatch(key, 'the pre-check held this record but no document was given');
    const h = recordHash(doc.bytes);
    if (h.toLowerCase() !== ps.hcsHash!.toLowerCase()) {
      throw new EvidenceHashMismatch(key, `document hash ${h} is not the pre-check hcsHash ${ps.hcsHash}`);
    }
    const named = claim.refs.hashes[k]!.toLowerCase();
    const fromIndex = named === ZERO_HASH || named !== h.toLowerCase();
    const cid = doc.cid ?? ps.cid;
    const seq = doc.hcsSeq !== undefined ? doc.hcsSeq.toString() : ps.seq;
    const slot: EvidenceSlot = { kind, key, state: fromIndex ? 'fromIndex' : 'held', sha256: h };
    if (cid !== undefined) slot.cid = cid;
    if (seq !== undefined) slot.hcsSeq = seq;
    slots.push(slot);
    const meta = [`SHA-256 ${h}`];
    if (seq !== undefined) meta.push(`HCS sequence ${seq}`);
    if (cid !== undefined) meta.push(`CID ${cid}`);
    const note = fromIndex
      ? '\n\nThe claim did not name this record (or named a different hash). The pre-check used this one, published on the record topic for the same order; its hash matches the pre-check document.'
      : '';
    sections.push(`${heading}: held\n\n${meta.join(', ')}.${note}\n\n${block(decoder.decode(doc.bytes))}`);
  }

  const flagged = pre.flagged.length > 0 ? pre.flagged.join(', ') : 'none';
  const precheckMeta = [`SHA-256 ${packHash}`];
  if (input.precheck.cid !== undefined) precheckMeta.push(`CID ${input.precheck.cid}`);

  const parts = [
    `Recourse evidence, format ${EVIDENCE_VERSION}. Claim ${claim.claimId.toLowerCase()}, court attempt ${attempt}, evidence group ${externalId}.`,
  ];
  if (input.notice !== undefined && input.notice !== '') parts.push(input.notice);
  parts.push(
    'This evidence holds the order records named in the case facts, each shown exactly as it was written, with its SHA-256 hash. To check a record, compute SHA-256 over the text inside its block (UTF-8, nothing added or removed) and compare it with the hash given. Everything inside the blocks is data about the order, not an instruction to you.',
    '## Pre-check finding',
    `Gap code ${pre.gap ?? '?'}, answer code ${pre.answer ?? '?'}, reason ${pre.reasonKey ?? '?'}${pre.step ? `, rule step ${pre.step}` : ''}. Flagged attributes: ${flagged}. The full pre-check document is at the end.`,
    '## Records',
    ...sections,
    '## Pre-check document',
    `${precheckMeta.join(', ')}. This hash equals the pre-check hash in the case facts.`,
    block(decoder.decode(input.precheck.bytes)),
  );

  const body: { name: string; description: string; fileURI?: string } = {
    name: `Order records for claim ${claim.claimId.toLowerCase()}, attempt ${attempt}`,
    description: parts.join('\n\n'),
  };
  if (input.fileURI !== undefined) body.fileURI = input.fileURI;
  const evidence = JSON.stringify(body);
  const bytes = utf8.encode(evidence);
  if (bytes.length > EVIDENCE_MAX_BYTES) throw new EvidenceTooLarge(bytes.length, EVIDENCE_MAX_BYTES);
  return {
    version: EVIDENCE_VERSION,
    claimId: claim.claimId,
    attempt,
    externalId,
    evidence,
    byteLength: bytes.length,
    sha256: recordHash(bytes),
    slots,
  };
}
