// The `docket-reason` document: why a case is on the docket, from codes only. It carries no party
// text, buyer data or record contents. The bytes are canonical JSON, so the hash is stable.

import { canonicalBytes, recordHash } from '@recourse/shared';
import type { Hex } from 'viem';
import type { CaseRow } from './schema.js';

export const OUTCOME_KEYS = ['unresolved', 'platform', 'shop', 'neither'] as const;
export type OutcomeKey = (typeof OUTCOME_KEYS)[number];

export function outcomeKey(outcome: number): OutcomeKey {
  return OUTCOME_KEYS[outcome] ?? 'unresolved';
}

const SENTENCES: Record<OutcomeKey, string> = {
  platform: 'The court ruled that the agent company was at fault and owes the shop.',
  shop: 'The court ruled that the shop was at fault, so the claim did not succeed.',
  neither: 'The court ruled that neither side was at fault.',
  unresolved: 'The court refused to rule twice and the pre-check named no side, so the claim is unresolved.',
};

const ZERO_TWICE_SUFFIX = ' The court refused to rule twice, so the pre-check answer was applied.';

export interface ReasonDoc {
  bytes: Uint8Array;
  hash: Hex;
}

export function reasonDoc(row: Pick<CaseRow, 'claimId' | 'gap' | 'answer' | 'ruling' | 'outcome' | 'zeroTwice' | 'attempts' | 'month'>): ReasonDoc {
  const key = outcomeKey(row.outcome);
  const sentence = SENTENCES[key] + (row.zeroTwice && row.outcome !== 0 ? ZERO_TWICE_SUFFIX : '');
  const bytes = canonicalBytes({
    v: '1',
    kind: 'docket-reason',
    claimId: row.claimId,
    month: row.month,
    gap: String(row.gap),
    answer: String(row.answer),
    ruling: String(row.ruling),
    outcome: key,
    zeroTwice: row.zeroTwice,
    attempts: String(row.attempts),
    sentence,
  });
  return { bytes, hash: recordHash(bytes) };
}

/** Pins document bytes and returns a CID, or null when no pin service is configured. */
export interface Pinner {
  pin(bytes: Uint8Array): Promise<string | null>;
}

export const nullPinner: Pinner = { pin: async () => null };
