import { describe, expect, it } from 'vitest';
import {
  CaseState,
  ClaimStatus,
  ExecutionState,
  PARAMS,
  canExpireClaim,
  claimExpiresAfter,
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
  preCheckedAt: T0 + 100n,
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
  const expiry = atCourt.preCheckedAt + LOCKED.claimTimeout;

  it('in flight before the case exists', () => {
    expect(deriveStatus(atCourt, null, [msg({ executionState: ExecutionState.InProgress })], LOCKED, T0 + 900n)).toMatchObject({
      statusKey: 'at_court',
      nextActor: 'none',
    });
  });

  it('caseDeadline after receivedAt when expiresAt is unknown: open one second before, stuck at equality', () => {
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
      deadline: expiry,
    });
    const waiting = [msg({ executionState: ExecutionState.Untouched, sentAt: T0 })];
    expect(deriveStatus(atCourt, null, waiting, LOCKED, T0 + LOCKED.stuckAfter).statusKey).toBe('at_court');
    expect(deriveStatus(atCourt, null, waiting, LOCKED, T0 + LOCKED.stuckAfter + 1n).nextCall).toBe('resend');
  });

  it('past the timeout, a ruling still on its way is never thrown away by advising expiry', () => {
    const after = expiry + 1n;
    const relayed = kase({ state: CaseState.Relayed, attempts: 1 });
    const back = (executionState: ExecutionState, sentAt = after - 300n) => [msg({}), msg({ direction: 'toHedera', executionState, sentAt })];
    const waitOnly = { statusKey: 'at_court', nextActor: 'none', nextCall: null, deadline: null };
    // Relayed five minutes ago, not delivered yet (or delivery not read yet): wait for it.
    expect(deriveStatus(atCourt, relayed, back(ExecutionState.Untouched), LOCKED, after)).toEqual(waitOnly);
    expect(deriveStatus(atCourt, relayed, back(ExecutionState.InProgress), LOCKED, after)).toEqual(waitOnly);
    expect(deriveStatus(atCourt, relayed, [msg({})], LOCKED, after)).toEqual(waitOnly);
    // Ruled on Arbitrum and not relayed: the keeper sends it back.
    expect(deriveStatus(atCourt, kase({ state: CaseState.Ruled, attempts: 1 }), [msg({})], LOCKED, after)).toEqual({
      statusKey: 'at_court',
      nextActor: 'keeper',
      nextCall: 'relayRuling',
      deadline: null,
    });
    expect(deriveStatus(atCourt, kase({ state: CaseState.Ruled, attempts: 2 }), [msg({})], LOCKED, after)).toMatchObject({
      statusKey: 'refused_once',
      nextCall: 'relayRuling',
    });
    // The return message has waited past stuckAfter: anyone may send it again, still not expire.
    expect(deriveStatus(atCourt, relayed, back(ExecutionState.Untouched, after - LOCKED.stuckAfter - 1n), LOCKED, after)).toEqual({
      statusKey: 'stuck',
      nextActor: 'anyone',
      nextCall: 'relayRuling',
      deadline: null,
    });
    // Nothing on its way: a return message Hedera took (recorded or ignored), or a case still being decided.
    expect(deriveStatus(atCourt, relayed, back(ExecutionState.Success), LOCKED, after).nextCall).toBe('expireClaim');
    expect(deriveStatus(atCourt, kase({ state: CaseState.Opened, attempts: 1 }), [msg({})], LOCKED, after).nextCall).toBe('expireClaim');
    expect(deriveStatus(atCourt, kase({ state: CaseState.Opened, attempts: 1, period: 3 }), [msg({})], LOCKED, after).nextCall).toBe('expireClaim');
    // Before the timeout nothing changes.
    expect(deriveStatus(atCourt, relayed, back(ExecutionState.Untouched), LOCKED, expiry)).toMatchObject({ statusKey: 'at_court', nextActor: 'none' });
  });

  it('past the timeout, a failed return message is still run by hand, not thrown away', () => {
    const after = expiry + 1n;
    const relayed = kase({ state: CaseState.Relayed, attempts: 1 });
    const failedBack = [msg({}), msg({ direction: 'toHedera', executionState: ExecutionState.Failure, sentAt: after - 300n })];
    // The same advice one second before and one second after the timeout; only the deadline goes.
    expect(deriveStatus(atCourt, relayed, failedBack, LOCKED, expiry)).toEqual({
      statusKey: 'stuck',
      nextActor: 'anyone',
      nextCall: 'manualExecute',
      deadline: expiry,
    });
    expect(deriveStatus(atCourt, relayed, failedBack, LOCKED, after)).toEqual({
      statusKey: 'stuck',
      nextActor: 'anyone',
      nextCall: 'manualExecute',
      deadline: null,
    });
    // The message counts on its own, before the case has been read.
    expect(deriveStatus(atCourt, null, failedBack, LOCKED, after).nextCall).toBe('manualExecute');
    // A resend that failed beside an earlier copy Hedera took: nothing is on its way.
    const tookFirst = [msg({}), msg({ direction: 'toHedera', sendNo: 1 }), msg({ direction: 'toHedera', sendNo: 2, executionState: ExecutionState.Failure })];
    expect(deriveStatus(atCourt, relayed, tookFirst, LOCKED, after).nextCall).toBe('expireClaim');
  });

  it('past the timeout, a case not read lately gets no expiry advice unless it can no longer move', () => {
    const after = expiry + 1n;
    const late = { caseLate: true };
    // Nothing read: "no case" may only mean the reads are behind.
    expect(deriveStatus(atCourt, null, [msg({})], LOCKED, after, late)).toEqual({ statusKey: 'at_court', nextActor: 'none', nextCall: null, deadline: null });
    expect(deriveStatus(atCourt, null, [msg({})], LOCKED, after).nextCall).toBe('expireClaim');
    // An old read of an open case: it may have been ruled since.
    const opened = kase({ state: CaseState.Opened, attempts: 1 });
    expect(deriveStatus(atCourt, opened, [msg({})], LOCKED, after, late)).toEqual({ statusKey: 'at_court', nextActor: 'court', nextCall: null, deadline: null });
    expect(deriveStatus(atCourt, opened, [msg({})], LOCKED, after).nextCall).toBe('expireClaim');
    // A Stale case, or one past its open deadline, cannot move again: expiry stands.
    expect(deriveStatus(atCourt, kase({ state: CaseState.Stale }), [msg({})], LOCKED, after, late).nextCall).toBe('expireClaim');
    expect(deriveStatus(atCourt, kase({ state: CaseState.Received }), [msg({})], LOCKED, after, late).nextCall).toBe('expireClaim');
    // Before the timeout a late read changes nothing.
    expect(deriveStatus(atCourt, opened, [msg({})], LOCKED, expiry, late)).toEqual(deriveStatus(atCourt, opened, [msg({})], LOCKED, expiry));
  });

  it('past the timeout, a dispute in its execution period waits for executeRuling, not expiry', () => {
    const after = expiry + 1n;
    const executing = kase({ state: CaseState.Opened, attempts: 1, disputeIds: [212n, 0n], period: 4 });
    expect(deriveStatus(atCourt, executing, [msg({})], LOCKED, after)).toEqual({
      statusKey: 'at_court',
      nextActor: 'court',
      nextCall: null,
      deadline: null,
    });
    expect(deriveStatus(atCourt, { ...executing, attempts: 2, disputeIds: [211n, 212n] }, [msg({})], LOCKED, after)).toEqual({
      statusKey: 'refused_once',
      nextActor: 'court',
      nextCall: null,
      deadline: null,
    });
    // Before the timeout it reads as it always did.
    expect(deriveStatus(atCourt, executing, [msg({})], LOCKED, expiry)).toEqual({ statusKey: 'at_court', nextActor: 'court', nextCall: null, deadline: null });
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

  it('a stale case is stuck with nothing to send until the timeout, then points to expireClaim; so does any stuck claim', () => {
    const stale = kase({ state: CaseState.Stale });
    const waitForExpiry = { statusKey: 'stuck', nextActor: 'none', nextCall: null, deadline: expiry };
    expect(deriveStatus(atCourt, stale, [msg({})], LOCKED, T0 + 900n)).toEqual(waitForExpiry);
    expect(deriveStatus(atCourt, stale, [msg({})], LOCKED, expiry)).toEqual(waitForExpiry);
    expect(canExpireClaim(atCourt, LOCKED.claimTimeout, expiry)).toBe(false);
    expect(deriveStatus(atCourt, stale, [msg({})], LOCKED, expiry + 1n)).toEqual({ ...waitForExpiry, nextActor: 'anyone', nextCall: 'expireClaim' });
    // A case past its open deadline cannot move either: the same wait.
    const received = kase({ state: CaseState.Received });
    expect(deriveStatus(atCourt, received, [msg({})], LOCKED, received.receivedAt + LOCKED.caseDeadline)).toEqual(waitForExpiry);
    // A return message that failed is still run by hand first.
    const failedBack = [msg({}), msg({ direction: 'toHedera', executionState: ExecutionState.Failure })];
    expect(deriveStatus(atCourt, stale, failedBack, LOCKED, T0 + 900n).nextCall).toBe('manualExecute');
    const failed = [msg({ executionState: ExecutionState.Failure })];
    expect(deriveStatus(atCourt, null, failed, LOCKED, expiry).nextCall).toBe('manualExecute');
    expect(deriveStatus(atCourt, null, failed, LOCKED, expiry + 1n).nextCall).toBe('expireClaim');
  });

  it('the court-stage timeout counts from preCheckedAt, strictly after', () => {
    const opened = kase({ state: CaseState.Opened, attempts: 1 });
    const filedBased = atCourt.filedAt + LOCKED.claimTimeout + 1n;
    expect(filedBased).toBeLessThanOrEqual(expiry);
    expect(deriveStatus(atCourt, opened, [msg({})], LOCKED, filedBased)).toMatchObject({ statusKey: 'at_court', nextActor: 'court' });
    expect(deriveStatus(atCourt, opened, [msg({})], LOCKED, expiry)).toMatchObject({ statusKey: 'at_court', nextActor: 'court' });
    expect(deriveStatus(atCourt, opened, [msg({})], LOCKED, expiry + 1n)).toEqual({
      statusKey: 'stuck',
      nextActor: 'anyone',
      nextCall: 'expireClaim',
      deadline: expiry,
    });
    expect(deriveStatus(atCourt, null, [], LOCKED, expiry + 1n).nextCall).toBe('expireClaim');
  });

  it("with Arbitrum's expiresAt, open and refile end caseDeadline before it (openBy), however early the case arrived", () => {
    // The case's claimTimeout is Hedera's less the 2 h relay budget.
    const arbExpires = atCourt.filedAt + LOCKED.claimTimeout - 7_200n;
    const openBy = arbExpires - LOCKED.caseDeadline;
    const received = kase({ state: CaseState.Received, expiresAt: arbExpires });
    // Long past receivedAt + caseDeadline the case still waits to open (a full cap or a short pool).
    expect(openBy).toBeGreaterThan(received.receivedAt + LOCKED.caseDeadline);
    expect(deriveStatus(atCourt, received, [msg({})], LOCKED, received.receivedAt + LOCKED.caseDeadline)).toEqual({
      statusKey: 'at_court',
      nextActor: 'keeper',
      nextCall: 'openCase',
      deadline: openBy,
    });
    expect(deriveStatus(atCourt, received, [msg({})], LOCKED, openBy - 1n)).toMatchObject({ statusKey: 'at_court', nextCall: 'openCase' });
    // From openBy it can only go Stale; expireClaim waits for Hedera's timeout, which is later.
    expect(openBy).toBeLessThan(expiry);
    expect(deriveStatus(atCourt, received, [msg({})], LOCKED, openBy)).toEqual({
      statusKey: 'stuck',
      nextActor: 'none',
      nextCall: null,
      deadline: expiry,
    });
    expect(deriveStatus(atCourt, received, [msg({})], LOCKED, expiry + 1n)).toMatchObject({ statusKey: 'stuck', nextActor: 'anyone', nextCall: 'expireClaim' });
    // A case that arrives after openBy can only go Stale.
    const late = kase({ state: CaseState.Received, receivedAt: openBy + 60n, expiresAt: arbExpires });
    expect(deriveStatus(atCourt, late, [msg({})], LOCKED, openBy + 61n)).toMatchObject({ statusKey: 'stuck', nextCall: null, deadline: expiry });
    const noExpiry = { ...received, expiresAt: 0n };
    expect(deriveStatus(atCourt, noExpiry, [msg({})], LOCKED, received.receivedAt)).toMatchObject({
      nextCall: 'openCase',
      deadline: received.receivedAt + LOCKED.caseDeadline,
    });
    const pending = kase({ state: CaseState.RefilePending, attempts: 1, ruledAt: T0 + 5_000n, expiresAt: arbExpires });
    expect(deriveStatus(atCourt, pending, [msg({})], LOCKED, T0 + 5_000n + LOCKED.caseDeadline)).toMatchObject({ nextCall: 'refile', deadline: openBy });
    expect(deriveStatus(atCourt, pending, [msg({})], LOCKED, openBy).statusKey).toBe('stuck');
    const opened = kase({ state: CaseState.Opened, attempts: 1, expiresAt: arbExpires });
    expect(deriveStatus(atCourt, opened, [msg({})], LOCKED, arbExpires + 1n)).toMatchObject({ statusKey: 'at_court', nextActor: 'court' });
  });
});

describe('claim expiry on Hedera', () => {
  const T = LOCKED.claimTimeout;

  it('Filed counts from filedAt, Contested and AtCourt from preCheckedAt, PreChecked never', () => {
    const filed = claim({ status: ClaimStatus.Filed, preCheckedAt: 0n });
    expect(claimExpiresAfter(filed, T)).toBe(T0 + T);
    expect(claimExpiresAfter(claim({ status: ClaimStatus.Contested }), T)).toBe(T0 + 100n + T);
    expect(claimExpiresAfter(claim({ status: ClaimStatus.AtCourt }), T)).toBe(T0 + 100n + T);
    for (const status of [ClaimStatus.PreChecked, ClaimStatus.Ruled, ClaimStatus.Settled, ClaimStatus.Closed, ClaimStatus.Expired]) {
      expect(claimExpiresAfter(claim({ status }), T)).toBeNull();
      expect(canExpireClaim(claim({ status }), T, T0 + 10n * T)).toBe(false);
    }
    expect(canExpireClaim(filed, T, T0 + T)).toBe(false);
    expect(canExpireClaim(filed, T, T0 + T + 1n)).toBe(true);
  });

  it('a Filed claim waits for the pre-check until filedAt + claimTimeout, then anyone may expire it', () => {
    const filed = claim({ status: ClaimStatus.Filed, preCheckedAt: 0n });
    expect(deriveStatus(filed, null, [], LOCKED, T0 + T)).toEqual({
      statusKey: 'filed',
      nextActor: 'preCheckSigner',
      nextCall: 'recordPreCheck',
      deadline: T0 + T,
    });
    expect(deriveStatus(filed, null, [], LOCKED, T0 + T + 1n)).toEqual({
      statusKey: 'filed',
      nextActor: 'anyone',
      nextCall: 'expireClaim',
      deadline: null,
    });
  });

  it('a Contested claim can go to court until preCheckedAt + claimTimeout, then expires', () => {
    const contested = claim({ status: ClaimStatus.Contested });
    const end = contested.preCheckedAt + T;
    expect(deriveStatus(contested, null, [], LOCKED, end)).toEqual({
      statusKey: 'contested',
      nextActor: 'anyone',
      nextCall: 'sendToCourt',
      deadline: end,
    });
    expect(deriveStatus(contested, null, [], LOCKED, end + 1n)).toMatchObject({ nextActor: 'anyone', nextCall: 'expireClaim' });
  });

  it('a PreChecked claim never expires: it closes uncontested', () => {
    const pc = claim({ status: ClaimStatus.PreChecked, answer: 1 });
    expect(deriveStatus(pc, null, [], LOCKED, T0 + 10n * T)).toMatchObject({ statusKey: 'window_lapsed', nextCall: 'closeUncontested' });
  });
});
