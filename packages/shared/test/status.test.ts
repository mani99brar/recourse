import { describe, expect, it } from 'vitest';
import {
  CaseState,
  ClaimStatus,
  ExecutionState,
  PARAMS,
  deriveStatus,
  type BridgeView,
  type CaseView,
  type ClaimForStatus,
  type LiveParams,
} from '../src/index.js';

const live = (set: typeof PARAMS.preLock): LiveParams => ({
  contestWindow: BigInt(set.contestWindow),
  claimTimeout: BigInt(set.claimTimeout),
  resendGap: BigInt(set.resendGap),
  maxSends: set.maxSends,
  caseDeadline: BigInt(set.caseDeadline),
  maxOpenCases: set.maxOpenCases,
  stuckAfter: BigInt(set.stuckAfter),
});
const LOCKED = live(PARAMS.locked);
const PRE = live(PARAMS.preLock);
const T0 = 1_800_000_000n;
const Z = `0x${'00'.repeat(32)}` as const;

const claim = (o: Partial<ClaimForStatus>): ClaimForStatus => ({
  status: ClaimStatus.Filed,
  answer: 0,
  ruling: 0,
  filedAt: T0,
  preCheckedAt: 0n,
  undrawn: false,
  ...o,
});
const kase = (o: Partial<CaseView>): CaseView => ({
  state: CaseState.Received,
  payloadHash: Z,
  receivedAt: T0 + 600n,
  attempts: 0,
  disputeIds: [0n, 0n],
  templateIds: [0n, 0n],
  ruling: 0,
  ruledAt: 0n,
  sendCount: 0,
  lastSendAt: 0n,
  lastMessageId: Z,
  ...o,
});
const msg = (o: Partial<BridgeView>): BridgeView => ({
  messageId: Z,
  direction: 'toArbitrum',
  sendNo: 1,
  executionState: ExecutionState.Success,
  sentAt: T0 + 500n,
  ...o,
});

describe('deriveStatus rows', () => {
  const now = T0 + 1_000n;
  it.each([
    ['1 expired', claim({ status: ClaimStatus.Expired }), 'expired', 'none', null],
    ['2 unresolved, ruled', claim({ status: ClaimStatus.Ruled, ruling: 0, answer: 0 }), 'unresolved', 'anyone', 'settle'],
    ['2 unresolved, settled', claim({ status: ClaimStatus.Settled, ruling: 0, answer: 0 }), 'unresolved', 'none', null],
    ['3 zero twice with an answer', claim({ status: ClaimStatus.Ruled, ruling: 0, answer: 2 }), 'zero_twice_answer_applied', 'anyone', 'settle'],
    ['4 ruled', claim({ status: ClaimStatus.Ruled, ruling: 1, answer: 1 }), 'ruled', 'anyone', 'settle'],
    ['5 settled', claim({ status: ClaimStatus.Settled, ruling: 1, answer: 1 }), 'settled', 'shop', 'withdrawCredit'],
    ['5 settled after zero twice with an answer', claim({ status: ClaimStatus.Settled, ruling: 0, answer: 1 }), 'settled', 'shop', 'withdrawCredit'],
    ['5a closed undrawn', claim({ status: ClaimStatus.Closed, undrawn: true }), 'closed_undrawn', 'shop', 'withdrawCredit'],
    ['6 closed', claim({ status: ClaimStatus.Closed }), 'closed_uncontested', 'shop', 'withdrawCredit'],
    ['10 contested', claim({ status: ClaimStatus.Contested }), 'contested', 'anyone', 'sendToCourt'],
    ['14 filed', claim({ status: ClaimStatus.Filed }), 'filed', 'preCheckSigner', 'recordPreCheck'],
  ] as const)('%s', (_n, c, key, actor, call) => {
    const s = deriveStatus(c, null, [], LOCKED, now);
    expect([s.statusKey, s.nextActor, s.nextCall]).toEqual([key, actor, call]);
  });

  it('throws for a claim that does not exist', () => {
    expect(() => deriveStatus(claim({ status: ClaimStatus.None }), null, [], LOCKED, T0)).toThrow();
  });
});

describe('pre-check window', () => {
  const pc = (answer: 0 | 1 | 2 | 3) => claim({ status: ClaimStatus.PreChecked, answer, preCheckedAt: T0 + 100n });

  it('finding_made at the boundary second, window_lapsed one second later', () => {
    const end = T0 + 100n + LOCKED.contestWindow;
    expect(deriveStatus(pc(1), null, [], LOCKED, end)).toEqual({
      statusKey: 'finding_made',
      nextActor: 'platform',
      nextCall: 'contest',
      deadline: end,
    });
    expect(deriveStatus(pc(1), null, [], LOCKED, end + 1n).statusKey).toBe('window_lapsed');
    expect(deriveStatus(pc(1), null, [], LOCKED, end + 1n).nextCall).toBe('closeUncontested');
  });

  it('the shop contests answers 2 and 3; answer 0 is no_finding', () => {
    expect(deriveStatus(pc(2), null, [], LOCKED, T0 + 200n).nextActor).toBe('shop');
    expect(deriveStatus(pc(3), null, [], LOCKED, T0 + 200n).nextActor).toBe('shop');
    expect(deriveStatus(pc(0), null, [], LOCKED, T0 + 200n)).toMatchObject({ statusKey: 'no_finding', nextActor: 'shop' });
  });

  it('the same claim reads differently under pre-lock and locked params', () => {
    const at = T0 + 100n + 601n;
    expect(deriveStatus(pc(1), null, [], PRE, at).statusKey).toBe('window_lapsed');
    expect(deriveStatus(pc(1), null, [], LOCKED, at).statusKey).toBe('finding_made');
  });
});

describe('at court', () => {
  const atCourt = claim({ status: ClaimStatus.AtCourt, answer: 1 });

  it('in flight before the case exists', () => {
    expect(deriveStatus(atCourt, null, [msg({ executionState: ExecutionState.InProgress })], LOCKED, T0 + 900n)).toMatchObject({
      statusKey: 'at_court',
      nextActor: 'none',
    });
  });

  it('caseDeadline: open one second before, stuck at equality', () => {
    const c = kase({ state: CaseState.Received });
    const deadline = c.receivedAt + LOCKED.caseDeadline;
    expect(deriveStatus(atCourt, c, [msg({})], LOCKED, deadline - 1n)).toEqual({
      statusKey: 'at_court',
      nextActor: 'keeper',
      nextCall: 'openCase',
      deadline,
    });
    expect(deriveStatus(atCourt, c, [msg({})], LOCKED, deadline).statusKey).toBe('stuck');
  });

  it('opened, ruled and relayed cases', () => {
    const s = (state: CaseState, attempts = 1) => deriveStatus(atCourt, kase({ state, attempts }), [msg({})], LOCKED, T0 + 900n);
    expect(s(CaseState.Opened)).toMatchObject({ statusKey: 'at_court', nextActor: 'court' });
    expect(s(CaseState.Ruled)).toMatchObject({ statusKey: 'at_court', nextActor: 'keeper', nextCall: 'relayRuling' });
    expect(s(CaseState.Relayed)).toMatchObject({ statusKey: 'at_court', nextActor: 'none' });
  });

  it('refused once: refile while pending, then the court', () => {
    const pending = kase({ state: CaseState.RefilePending, attempts: 1, ruledAt: T0 + 5_000n });
    expect(deriveStatus(atCourt, pending, [msg({})], LOCKED, T0 + 5_100n)).toEqual({
      statusKey: 'refused_once',
      nextActor: 'anyone',
      nextCall: 'refile',
      deadline: T0 + 5_000n + LOCKED.caseDeadline,
    });
    const second = kase({ state: CaseState.Opened, attempts: 2 });
    expect(deriveStatus(atCourt, second, [msg({})], LOCKED, T0 + 5_100n)).toMatchObject({
      statusKey: 'refused_once',
      nextActor: 'court',
    });
    expect(deriveStatus(atCourt, pending, [msg({})], LOCKED, T0 + 5_000n + LOCKED.caseDeadline).statusKey).toBe('stuck');
  });

  it('stuck when the latest message on a leg failed, or waited past stuckAfter', () => {
    const failedOut = [msg({ executionState: ExecutionState.Failure })];
    expect(deriveStatus(atCourt, null, failedOut, LOCKED, T0 + 900n)).toEqual({
      statusKey: 'stuck',
      nextActor: 'anyone',
      nextCall: 'manualExecute',
      deadline: T0 + LOCKED.claimTimeout,
    });
    const waiting = [msg({ executionState: ExecutionState.Untouched, sentAt: T0 })];
    expect(deriveStatus(atCourt, null, waiting, LOCKED, T0 + LOCKED.stuckAfter).statusKey).toBe('at_court');
    expect(deriveStatus(atCourt, null, waiting, LOCKED, T0 + LOCKED.stuckAfter + 1n).nextCall).toBe('resend');
  });

  it('a failed return leg beside a successful outbound one is stuck', () => {
    const views = [msg({}), msg({ direction: 'toHedera', executionState: ExecutionState.Failure })];
    const c = kase({ state: CaseState.Relayed, attempts: 1 });
    expect(deriveStatus(atCourt, c, views, LOCKED, T0 + 9_000n)).toMatchObject({ statusKey: 'stuck', nextCall: 'manualExecute' });
    const waitingBack = [msg({}), msg({ direction: 'toHedera', executionState: ExecutionState.Untouched, sentAt: T0 })];
    expect(deriveStatus(atCourt, c, waitingBack, LOCKED, T0 + 9_000n).nextCall).toBe('relayRuling');
  });

  it('an older failed send beside a newer successful one is not stuck', () => {
    const views = [msg({ sendNo: 1, executionState: ExecutionState.Failure }), msg({ sendNo: 2 })];
    expect(deriveStatus(atCourt, kase({ state: CaseState.Opened, attempts: 1 }), views, LOCKED, T0 + 900n).statusKey).toBe(
      'at_court',
    );
  });

  it('a stale case points to expireClaim; so does any stuck claim past the timeout', () => {
    const stale = kase({ state: CaseState.Stale });
    expect(deriveStatus(atCourt, stale, [msg({})], LOCKED, T0 + 900n)).toMatchObject({ statusKey: 'stuck', nextCall: 'expireClaim' });
    const failed = [msg({ executionState: ExecutionState.Failure })];
    expect(deriveStatus(atCourt, null, failed, LOCKED, T0 + LOCKED.claimTimeout + 1n).nextCall).toBe('expireClaim');
  });
});
