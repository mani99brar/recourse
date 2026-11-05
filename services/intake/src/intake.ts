// Builds the answer to one intake request: the shared rule's result on the records alone, the
// optional tag, and a pack of hashes (never the complaint text) that may be pinned.

import { canonicalBytes, isHex32, recordHash, runFaultRule, ruleSlotFromDoc, withSlot, RECORD_KEYS, type PrecheckResult, type RuleInput, type RecordKind } from '@recourse/shared';
type Hex = `0x${string}`;
import type { LlmStatus, LlmTag, Tagger } from './tagger.js';

export interface RecordRef {
  cid: string;
  hash: Hex;
}
export type RecordInput = RecordRef | Record<string, unknown>;
export interface IntakeRequest {
  orderId?: string;
  complaint?: string;
  records?: Partial<Record<(typeof RECORD_KEYS)[number], RecordInput>>;
}

export interface Pinner {
  pin(bytes: Uint8Array): Promise<string | null>;
}
export type Fetcher = (cid: string, hash: Hex) => Promise<Uint8Array>;

export interface IntakeResponse {
  ruleResult: PrecheckResult;
  llmTag: LlmTag | null;
  llmStatus: LlmStatus;
  packCid: string | null;
  packHash: Hex;
  /** Records that could not be used, with why. */
  notes: { record: string; problem: string }[];
  pack: Record<string, unknown>;
}

function isRef(v: RecordInput): v is RecordRef {
  return typeof (v as RecordRef).cid === 'string' && isHex32((v as RecordRef).hash) && Object.keys(v).length === 2;
}

export async function runIntake(req: IntakeRequest, deps: { tagger: Tagger; pinner?: Pinner; fetcher?: Fetcher }): Promise<IntakeResponse> {
  const notes: { record: string; problem: string }[] = [];
  const refs: { kind: string; cid?: string; hash: Hex }[] = [];
  let input: RuleInput = {};

  // The order id: given, or the one the first inline document carries.
  let orderId = req.orderId?.toLowerCase();
  if (orderId === undefined) {
    for (const v of Object.values(req.records ?? {})) {
      const o = v && !isRef(v) ? (v as { orderId?: unknown }).orderId : undefined;
      if (typeof o === 'string') {
        orderId = o.toLowerCase();
        break;
      }
    }
  }

  for (const [key, value] of Object.entries(req.records ?? {})) {
    const kind = (RECORD_KEYS as readonly string[]).indexOf(key);
    if (kind < 0 || value === undefined) continue;
    if (!isHex32(orderId)) {
      notes.push({ record: key, problem: 'no valid order id' });
      continue;
    }
    try {
      let bytes: Uint8Array;
      let ref: { kind: string; cid?: string; hash: Hex };
      if (isRef(value)) {
        if (deps.fetcher === undefined) {
          notes.push({ record: key, problem: 'documents by CID are not fetched here' });
          continue;
        }
        bytes = await deps.fetcher(value.cid, value.hash);
        ref = { kind: key, cid: value.cid, hash: value.hash };
      } else {
        bytes = canonicalBytes(value as never);
        ref = { kind: key, hash: recordHash(bytes) };
      }
      const slot = ruleSlotFromDoc(kind as RecordKind, bytes, orderId);
      if (!slot.ok) {
        notes.push({ record: key, problem: slot.error });
        continue;
      }
      input = withSlot(input, slot);
      refs.push(ref);
    } catch (error) {
      notes.push({ record: key, problem: error instanceof Error ? error.message.slice(0, 80) : 'unreadable' });
    }
  }

  const ruleResult = runFaultRule(input);
  const complaint = req.complaint ?? '';
  const { tag, status } = await deps.tagger.tag(complaint);

  const pack = {
    v: '1',
    kind: 'intake-pack',
    ruleResult: { gap: String(ruleResult.gap), answer: String(ruleResult.answer), reasonKey: ruleResult.reasonKey, step: ruleResult.step },
    llmTag: tag ?? 'none',
    llmStatus: status,
    records: refs,
    complaintHash: complaint === '' ? '' : recordHash(new TextEncoder().encode(complaint)),
  };
  const bytes = canonicalBytes(pack as never);
  let packCid: string | null = null;
  try {
    packCid = (await deps.pinner?.pin(bytes)) ?? null;
  } catch {
    packCid = null; // a failed pin never fails the request
  }
  return { ruleResult, llmTag: tag, llmStatus: status, packCid, packHash: recordHash(bytes), notes, pack };
}
