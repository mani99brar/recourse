// Display words. Machine keys come from the shared package; the words are chosen here.
import type { NextActor, NextCall, StatusKey } from '@recourse/shared';

export const STATUS_WORDS: Record<StatusKey, { title: string; plain: string }> = {
  filed: { title: 'Filed', plain: 'The shop has filed the claim. The pre-check has not run yet.' },
  finding_made: { title: 'Finding made', plain: 'The pre-check named a side at fault. That side can contest until the window closes.' },
  no_finding: { title: 'No finding', plain: 'The records did not settle who is at fault. The shop can contest until the window closes.' },
  window_lapsed: { title: 'Window lapsed', plain: 'Nobody contested in time. Anyone can now close the claim on the pre-check finding.' },
  closed_uncontested: { title: 'Closed, not contested', plain: 'The claim closed on the pre-check finding. The money has been applied.' },
  contested: { title: 'Contested', plain: 'A side contested. The claim is ready to be sent to the court.' },
  at_court: { title: 'At court', plain: 'The claim is with the court. Jurors rule in their own time, often over an hour.' },
  stuck: { title: 'Stuck', plain: 'A message between the chains has not arrived. Anyone can retry it, or end the claim after the timeout.' },
  refused_once: { title: 'Court declined once', plain: 'The court did not give an answer the first time. The case is filed once more.' },
  ruled: { title: 'Ruled', plain: 'The court has ruled. Anyone can now settle the claim.' },
  zero_twice_answer_applied: { title: 'Court declined twice, pre-check applied', plain: 'The court declined twice, so the pre-check finding decides the money.' },
  unresolved: { title: 'Unresolved', plain: 'The court declined twice and the pre-check had no finding. The court fee is split.' },
  settled: { title: 'Settled', plain: 'The claim is settled and the money has been applied.' },
  expired: { title: 'Expired', plain: 'The claim ran out of time. The shop got its court fee back.' },
  closed_undrawn: { title: 'Closed, not drawn', plain: 'The claim was left out of the sample. The shop got its court fee back; no payout.' },
};

export const ACTOR_WORDS: Record<NextActor, string> = {
  none: 'Nobody (waiting on the system)',
  anyone: 'Anyone',
  shop: 'The shop',
  platform: 'The agent company',
  keeper: 'The Recourse keeper',
  court: 'The court',
  preCheckSigner: 'The pre-check service',
};

export const CALL_WORDS: Record<NextCall, string> = {
  recordPreCheck: 'record the pre-check',
  contest: 'contest',
  closeUncontested: 'close the claim',
  sendToCourt: 'send the claim to court',
  openCase: 'open the court case',
  refile: 'file the case again',
  resend: 'resend the message',
  relayRuling: 'send the ruling back',
  manualExecute: 'run the failed message by hand',
  expireClaim: 'end the claim',
  settle: 'settle',
  withdrawCredit: 'withdraw the credit',
};

export const FATE_WORDS: Record<string, string> = {
  held: 'Held until the claim ends',
  refunded: 'Returned to the shop',
  kept_by_pool: 'Kept by the court-fee pool',
  split: 'Partly returned, partly kept',
  none: 'Not escrowed',
};

export const GROUP_WORDS: Record<string, string> = {
  waitingOnYou: 'Waiting on you',
  waitingOnOther: 'Waiting on someone else',
  openToAnyone: 'Open to anyone',
  owedToYou: 'Money owed to you',
  finished: 'Finished',
};

export const REASON_WORDS: Record<string, string> = {
  not_enough_record: 'There are not enough records to say who is at fault.',
  missing_record_platform: 'A record the agent company should have written is missing.',
  missing_record_shop: 'The shop did not write its packing record.',
  gap1_asked_vs_shown: 'What the buyer asked for differs from what the agent was shown, and the change was not approved.',
  gap2_shown_vs_ordered: 'What the agent was shown differs from what it ordered.',
  gap3_ordered_vs_packed: 'What was ordered differs from what the shop packed.',
  gap3_packed_vs_arrived: 'What the shop packed differs from what arrived.',
  gap3_no_pack_record: 'There is no packing record, and what arrived differs from what was ordered.',
  no_gap_approved_change: 'A change was shown and approved. The records otherwise agree.',
  no_gap_all_agree: 'All the records agree.',
  no_gap_in_compared: 'The records agree where they can be compared, but some details were not compared.',
};

export const KIND_WORDS = ['Asked', 'Shown', 'Approval', 'Ordered', 'Packed', 'Arrived'] as const;

export const SIDE_WORDS: Record<string, string> = {
  platform: 'the agent company',
  shop: 'the shop',
  neither: 'neither side',
  none: 'no one yet',
};

export const COURT_PERIODS: Record<string, string> = {
  evidence: 'Evidence',
  commit: 'Jurors committing votes',
  vote: 'Jurors voting',
  appeal: 'Appeal window',
  execution: 'Ruling being applied',
};

/**
 * The plain sentence for a status. A ruling on its way back to Hedera gets its own words: the
 * generic "stuck" text offers ending the claim, which would throw the ruling away.
 */
export function statusPlain(key: StatusKey, call: NextCall | null, courtState?: string): string {
  if (call === 'relayRuling') {
    return key === 'stuck'
      ? "The court has ruled, but the ruling has not arrived on Hedera. Anyone can send it again. Ending the claim instead would throw the ruling away."
      : 'The court has ruled. The ruling is being sent back to Hedera, where it decides the claim.';
  }
  if (call === 'manualExecute' && courtState === 'relayed') {
    return 'The court has ruled, but the message carrying the ruling failed on Hedera. Anyone can run it by hand. Ending the claim instead would throw the ruling away.';
  }
  if ((key === 'at_court' || key === 'refused_once') && call === null && courtState === 'relayed') {
    return 'The court has ruled and the ruling is on its way back to Hedera, where it decides the claim.';
  }
  return STATUS_WORDS[key].plain;
}

/** Plain label for a status deadline. Never assumes a deadline exists. */
export function deadlineLabel(key: StatusKey, call: NextCall | null): string {
  if (key === 'filed') return 'Expires if not pre-checked by';
  if (key === 'contested') return 'Expires if no ruling by';
  if (key === 'finding_made' || key === 'no_finding') return 'Contest window ends';
  if (key === 'stuck') return 'Can be ended after';
  if (call === 'openCase') return 'The court case must be opened by';
  if (call === 'refile') return 'The case must be filed again by';
  return 'Deadline';
}
