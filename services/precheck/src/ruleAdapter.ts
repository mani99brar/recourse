// Held records in, the shared fault rule out. Nothing else happens here: no normalising, no
// judgement. Records that are absent or rejected are left out of the rule input.

import {
  runFaultRule,
  ruleSlotFromDoc,
  withSlot,
  type PrecheckResult,
  type RuleInput,
} from '@recourse/shared';
import type { Hex } from 'viem';
import type { SlotOutcome } from './slots.js';

export function ruleInputFrom(slots: readonly SlotOutcome[], orderId: Hex): RuleInput {
  let input: RuleInput = {};
  for (const s of slots) {
    if (s.outcome !== 'held') continue;
    const r = ruleSlotFromDoc(s.kind, s.bytes, orderId);
    // The proof already ran this on the same bytes, so a failure here means the slots were altered.
    if (!r.ok) throw new Error(`held record ${s.kind} no longer reads as a record document: ${r.error}`);
    input = withSlot(input, r);
  }
  return input;
}

export function runRule(slots: readonly SlotOutcome[], orderId: Hex): PrecheckResult {
  return runFaultRule(ruleInputFrom(slots, orderId));
}
