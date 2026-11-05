// The claim lifecycle as data: for each keeper phase, what puts a claim there, which call the
// keeper makes, how long that normally takes, when it alerts, and what it does when time runs
// out. The machine reads these rows; the handlers only add the chain reads each call needs.
// Across Sent to RefilePending (and after a Hedera expiry) the keeper also calls the case's
// markStale once its expiresAt (filedAt + the case's claimTimeout) has passed, so an expired case
// never keeps an open-case slot.

import type { AlertKind } from './alerts.js';
import type { Chain, Phase } from './types.js';

export interface Stall {
  kind: AlertKind;
  /** Seconds after the phase milestone (or after the contest window for `fromWindowEnd`). */
  afterS: number;
  fromWindowEnd?: boolean;
}

export interface Row {
  phase: Phase;
  enteredOn: string;
  /** Contract function the keeper calls in this phase; null when it only watches. */
  call: string | null;
  chain?: Chain;
  /** Usual time to leave the phase, seconds. */
  expectedS: number | null;
  stalls: Stall[];
  /** Seconds between tries of the call. */
  retryEveryS?: number;
  /** Tries before the claim is held and the stall alert is raised; unlimited when absent. */
  maxTries?: number;
  /** Alert raised when `maxTries` is used up (defaults to the first stall kind). */
  exhaustedAlert?: AlertKind;
  /**
   * The Hedera claim can be expired from this phase: a Filed claim strictly after filedAt +
   * claimTimeout, a Contested or AtCourt claim strictly after preCheckedAt + claimTimeout. A
   * PreChecked claim never expires (it closes uncontested).
   */
  expirable: boolean;
  /** What happens when the phase's own time runs out. */
  onTimeout: string;
}

export const TABLE: readonly Row[] = [
  {
    phase: 'Filed',
    enteredOn: 'ClaimFiled (Hedera)',
    call: null,
    expectedS: 300,
    stalls: [{ kind: 'precheck_late', afterS: 600 }],
    expirable: true,
    onTimeout: 'expireClaim once now > filedAt + claimTimeout',
  },
  {
    phase: 'PreChecked',
    enteredOn: 'PreCheckRecorded (Hedera)',
    call: 'closeUncontested',
    chain: 'hedera',
    expectedS: null, // the contest window
    stalls: [{ kind: 'close_late', afterS: 600, fromWindowEnd: true }],
    retryEveryS: 120,
    expirable: false,
    onTimeout: 'retry closeUncontested every 2 min',
  },
  {
    phase: 'Contested',
    enteredOn: 'Contested (Hedera)',
    call: 'sendToCourt',
    chain: 'hedera',
    expectedS: 120,
    stalls: [{ kind: 'send_late', afterS: 600 }],
    retryEveryS: 60,
    maxTries: 5,
    expirable: true,
    onTimeout: 'hold after 5 failed tries; expireClaim once now > preCheckedAt + claimTimeout',
  },
  {
    phase: 'Sent',
    enteredOn: 'SentToCourt (Hedera)',
    call: 'resend',
    chain: 'hedera',
    expectedS: 41,
    stalls: [{ kind: 'outbound_slow', afterS: 600 }],
    expirable: true,
    onTimeout: 'resend when Untouched 60 min after the last send and the contract allows it; exec_failure on Failure',
  },
  {
    phase: 'Delivered',
    enteredOn: 'ClaimReceived (Arbitrum) and OffRamp state Success',
    call: 'openCase',
    chain: 'arbitrum',
    expectedS: 120,
    stalls: [{ kind: 'open_late', afterS: 300 }],
    retryEveryS: 120,
    expirable: true,
    onTimeout: 'retry every 2 min until caseDeadline or expiresAt; alert on a short fee pool or the case cap',
  },
  {
    phase: 'Opened',
    enteredOn: 'CaseOpened and DisputeRequest in one transaction (Arbitrum)',
    call: 'submitEvidence',
    chain: 'arbitrum',
    expectedS: 300,
    stalls: [
      { kind: 'evidence_late', afterS: 240 },
      { kind: 'evidence_missed', afterS: 900 },
    ],
    retryEveryS: 30,
    expirable: true,
    onTimeout: 'retry every 30 s for 15 min (the evidence period), then evidence_missed',
  },
  {
    phase: 'Watching',
    enteredOn: 'our evidence transaction confirmed',
    call: null,
    expectedS: 4380, // rule() lands 53-155 min after opening; 73 min median
    stalls: [
      { kind: 'juror_absent', afterS: 1800 },
      { kind: 'ruling_slow', afterS: 9600 },
    ],
    expirable: true,
    onTimeout: 'read currentRuling from +25 min every 5 min; permissionless Kleros nudges when a period is overdue',
  },
  {
    phase: 'RefilePending',
    enteredOn: 'RefileNeeded (Arbitrum)',
    call: 'refile',
    chain: 'arbitrum',
    expectedS: 600,
    stalls: [{ kind: 'refile_late', afterS: 1200 }],
    retryEveryS: 120,
    expirable: true,
    onTimeout: 'refile after the hold, then back to Opened for attempt 2',
  },
  {
    phase: 'RuledArb',
    enteredOn: 'RulingFinal (Arbitrum)',
    call: 'relayRuling',
    chain: 'arbitrum',
    expectedS: 120,
    stalls: [{ kind: 'relay_late', afterS: 600 }],
    retryEveryS: 60,
    maxTries: 5,
    expirable: true,
    onTimeout: 'hold after 5 failed tries (recordRuling on Hedera in the one-leg modes)',
  },
  {
    phase: 'Relayed',
    enteredOn: 'RulingRelayed (Arbitrum)',
    call: 'relayRuling',
    chain: 'arbitrum',
    expectedS: 1500,
    stalls: [{ kind: 'return_slow', afterS: 2700 }],
    expirable: true,
    onTimeout: 'relay again when Untouched 60 min after the last send and the contract allows it; exec_failure on Failure',
  },
  {
    phase: 'RuledHedera',
    enteredOn: 'RulingReceived (Hedera)',
    call: 'settle',
    chain: 'hedera',
    expectedS: 120,
    stalls: [{ kind: 'settle_late', afterS: 600 }],
    retryEveryS: 300,
    maxTries: 6,
    exhaustedAlert: 'settle_failed',
    expirable: false,
    onTimeout: 'retry every 5 min, 6 times, then hold and alert settle_failed',
  },
  {
    phase: 'Stale',
    enteredOn: 'ClaimStale (Arbitrum): openCase or refile past its deadline or expiresAt, or markStale',
    call: null,
    expectedS: null,
    stalls: [{ kind: 'claim_stale', afterS: 0 }],
    expirable: true,
    onTimeout: 'expireClaim on Hedera once now > preCheckedAt + claimTimeout',
  },
  { phase: 'Settled', enteredOn: 'Settled (Hedera)', call: null, expectedS: null, stalls: [], expirable: false, onTimeout: 'terminal' },
  { phase: 'Closed', enteredOn: 'ClosedUncontested (Hedera)', call: null, expectedS: null, stalls: [], expirable: false, onTimeout: 'terminal' },
  { phase: 'Expired', enteredOn: 'ClaimExpired (Hedera)', call: null, expectedS: null, stalls: [], expirable: false, onTimeout: 'terminal' },
];

export function rowOf(phase: Phase): Row {
  const r = TABLE.find((x) => x.phase === phase);
  if (!r) throw new Error(`no table row for ${phase}`);
  return r;
}

/** Keeper timing knobs that are not contract parameters. */
export interface Timing {
  /** Wait after the last send before a resend or re-relay of an Untouched message. */
  resendWaitS: number;
  /** Receiver dropped it: state Success with no receive event after this long. */
  deliveredGraceS: number;
  /** First currentRuling read after opening, then the interval. */
  rulingReadFromS: number;
  rulingReadEveryS: number;
  /** Hold after RefileNeeded before refiling. */
  refileHoldS: number;
  /** A Kleros period overdue by more than this gets a permissionless nudge. */
  nudgeAfterS: number;
  /** relayRuling stops this long before a Hedera pause window (the message lands 15-25 min later). */
  relayLeadS: number;
  /** Funding checks interval. */
  levelsEveryS: number;
  /** Open the case without built evidence once the case deadline is this close. */
  openWithoutEvidenceS: number;
}

export const DEFAULT_TIMING: Timing = {
  resendWaitS: 3600,
  deliveredGraceS: 300,
  rulingReadFromS: 1500,
  rulingReadEveryS: 300,
  refileHoldS: 600,
  nudgeAfterS: 600,
  relayLeadS: 1800,
  levelsEveryS: 600,
  openWithoutEvidenceS: 900,
};
