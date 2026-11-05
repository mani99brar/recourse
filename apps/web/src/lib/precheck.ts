// The in-browser pre-check: the shared fault rule applied to the records the API serves.
import {
  RECORD_KEYS,
  canonicalBytes,
  runFaultRule,
  ruleSlotFromDoc,
  withSlot,
  type PrecheckResult,
  type RecordKind,
  type RuleInput,
} from '@recourse/shared';
import type { Hex } from 'viem';

export interface ServedRecord {
  kind: number;
  held: boolean | null;
  doc: unknown | null;
}

export interface PrecheckOutcome {
  result: PrecheckResult;
  used: number[];
  skipped: { kind: number; why: string }[];
}

/** Runs the rule on the records that are verified (held) and readable. Others are left out, and listed. */
export function precheckFromRecords(orderId: Hex, records: readonly ServedRecord[]): PrecheckOutcome {
  let input: RuleInput = {};
  const used: number[] = [];
  const skipped: { kind: number; why: string }[] = [];
  for (const r of records) {
    if (r.held !== true || r.doc === null || r.doc === undefined) {
      skipped.push({ kind: r.kind, why: r.held === null ? 'could not be checked yet' : 'not found or failed a check' });
      continue;
    }
    const slot = ruleSlotFromDoc(r.kind as RecordKind, canonicalBytes(r.doc as never), orderId);
    if (!slot.ok) {
      skipped.push({ kind: r.kind, why: slot.error });
      continue;
    }
    input = withSlot(input, slot);
    used.push(r.kind);
  }
  return { result: runFaultRule(input), used, skipped };
}

export function recordName(kind: number): string {
  return RECORD_KEYS[kind] ?? 'unknown';
}
