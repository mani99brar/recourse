// The pre-check result document: canonical JSON, all strings, no run-time stamps. The same claim
// and chain data always give the same bytes and so the same packHash.

import {
  RULE_VERSION,
  canonicalBytes,
  packHash,
  type CanonicalValue,
  type PrecheckResult,
  type ReasonKey,
} from '@recourse/shared';
import type { Hex } from 'viem';
import type { SlotOutcome } from './slots.js';

/** One neutral sentence per reason key, describing what the records show. */
export const REASON_TEXT: Record<ReasonKey, string> = {
  not_enough_record: 'The ordered record is not held, so the records do not show enough to compare.',
  missing_record_platform:
    'A record that should come from the ordering side is missing or failed its checks, and the records held show no break before it.',
  missing_record_shop:
    'The packed record is missing or failed its checks, and the records held show no break before it.',
  gap1_asked_vs_shown:
    'The ordered record departs from the asked record on at least one attribute, and the shown record and approval do not cover the change.',
  gap2_shown_vs_ordered: 'The shown record and the ordered record differ on at least one attribute.',
  gap3_ordered_vs_packed: 'The ordered record and the packed record differ on at least one attribute.',
  gap3_packed_vs_arrived: 'The packed record and the arrived record differ on at least one attribute.',
  gap3_no_pack_record:
    'There is no packed record, and the ordered record and the arrived record differ on at least one attribute.',
  no_gap_approved_change:
    'The ordered record departs from the asked record, and the shown record and an approval cover the change; the other held records agree.',
  no_gap_all_agree: 'All held records agree on every attribute they share.',
  no_gap_in_compared:
    'No difference was found between the records that could be compared, but some held attributes or records had no counterpart to compare with.',
};

/**
 * Step 2b gives the gap1 key too, for the opposite shape: the shown record departed from the asked
 * record while the ordered record kept to it. The step-2a sentence would be false there.
 */
export const REASON_TEXT_2B =
  'The shown record departs from the asked record on at least one attribute while the ordered record keeps to it, and no approved change covers it.';

/** The sentence for a result: by reason key, except step 2b. */
export function reasonTextOf(r: Pick<PrecheckResult, 'reasonKey' | 'step'>): string {
  return r.step === '2b' ? REASON_TEXT_2B : REASON_TEXT[r.reasonKey];
}

export interface ResultDocInput {
  claimId: Hex;
  orderId: Hex;
  slots: readonly SlotOutcome[];
  result: PrecheckResult;
}

export interface ResultDoc {
  bytes: Uint8Array;
  packHash: Hex;
}

function recordEntry(s: SlotOutcome): CanonicalValue {
  const base = { kind: String(s.kind), outcome: s.outcome };
  if (s.outcome === 'absent') return base;
  if (s.outcome === 'rejected') {
    return { ...base, reason: s.reason, seq: s.seq?.toString(), hcsHash: s.hcsHash, cid: s.cid };
  }
  return {
    ...base,
    seq: s.seq.toString(),
    hcsHash: s.hcsHash,
    cid: s.cid,
    payer: s.payer,
    consensusAt: s.consensusAt,
    refsSeq: s.refs?.seq.toString(),
    refsHash: s.refs?.hash,
    refsReason: s.refs?.reason,
  };
}

export function buildResultDoc(input: ResultDocInput): ResultDoc {
  const r = input.result;
  const doc: CanonicalValue = {
    v: '1',
    claimId: input.claimId,
    orderId: input.orderId,
    ruleVersion: RULE_VERSION,
    records: input.slots.map(recordEntry),
    result: {
      gap: String(r.gap),
      answer: String(r.answer),
      side: r.side,
      reasonKey: r.reasonKey,
      step: r.step,
      flaggedCells: r.flaggedCells.map((c) => ({ record: c.record, attribute: c.attribute })),
      notCompared: [...r.notCompared],
      unreadPrice: [...r.unreadPrice],
    },
    gap: String(r.gap),
    answer: String(r.answer),
    reasonKey: r.reasonKey,
    reasonText: reasonTextOf(r),
  };
  const bytes = canonicalBytes(doc);
  return { bytes, packHash: packHash(bytes) };
}
