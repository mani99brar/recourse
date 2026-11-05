import { describe, expect, it } from 'vitest';
import { E, NOV, cid, rig } from './helpers.js';

const claim = [E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1)];

describe('write failures', () => {
  it('leaves failed with the reason for auth, quota and gas, and retries after the interval', async () => {
    for (const [message, kind] of [['HTTP 401 unauthorized', 'auth'], ['quota exceeded', 'quota'], ['insufficient funds for gas', 'gas'], ['connection reset', 'rpc']] as const) {
      const r = rig();
      r.docket.ingest(claim);
      r.io.failWith.push(new Error(message));
      await r.docket.flush();
      const s = r.docket.writeStatus(cid(1))!;
      expect(s.writeStatus).toBe('failed');
      expect(s.errorKind).toBe(kind);
      expect(s.attempts).toBe(1);
      expect(s.lastError).not.toBeNull();

      // not retried before the interval
      await r.docket.flush();
      expect(r.docket.writeStatus(cid(1))?.attempts).toBe(1);
      expect([...r.io.entities.values()].filter((e) => e.schema === 'case')).toHaveLength(0);

      r.clock.t += 601;
      await r.docket.flush();
      expect(r.docket.writeStatus(cid(1))).toMatchObject({ writeStatus: 'written', lastError: null, attempts: 0 });
    }
  });

  it('stops retrying after the maximum, holds failed, and alerts once', async () => {
    const r = rig();
    r.docket.ingest(claim);
    for (let i = 0; i < 6; i++) {
      r.io.failWith.push(new Error('connection reset'));
      await r.docket.flush();
      r.clock.t += 601;
    }
    const s = r.docket.writeStatus(cid(1))!;
    expect(s.writeStatus).toBe('failed');
    expect(s.attempts).toBe(3);
    expect(r.alerts.filter((a) => a.includes(cid(1)))).toHaveLength(1);
    // held: a healthy store is not tried again for this claim
    await r.docket.flush();
    expect(r.docket.writeStatus(cid(1))?.writeStatus).toBe('failed');
  });

  it('does not let one failing claim block the next', async () => {
    const r = rig();
    r.docket.ingest([...claim, E.filed(2), E.precheck(2, 1, 1), E.ruling(2, 1, 1, NOV + 7300)]);
    r.io.failWith.push(new Error('connection reset'));
    await r.docket.flush();
    expect(r.docket.writeStatus(cid(1))?.writeStatus).toBe('failed');
    expect(r.docket.writeStatus(cid(2))?.writeStatus).toBe('written');
  });

  it('survives a restart with a failed write and keeps its attempt count', async () => {
    const r = rig();
    r.docket.ingest(claim);
    r.io.failWith.push(new Error('quota exceeded'));
    await r.docket.flush();
    const again = r.reopen();
    expect(again.writeStatus(cid(1))).toMatchObject({ writeStatus: 'failed', attempts: 1, errorKind: 'quota' });
  });

  it('a failed settlement patch leaves the case written and flags the pending update', async () => {
    const r = rig();
    r.docket.ingest(claim);
    await r.docket.flush();
    r.docket.ingest([E.applied(1, '3000000'), E.settled(1)]);
    r.io.failWith.push(new Error('connection reset'));
    await r.docket.flush();
    expect(r.docket.writeStatus(cid(1))).toMatchObject({ writeStatus: 'written', settlementPending: true, errorKind: 'rpc' });
    r.clock.t += 601;
    await r.docket.flush();
    expect(r.docket.writeStatus(cid(1))).toMatchObject({ writeStatus: 'written', settlementPending: false });
  });

  it('an auth failure ends the pass instead of failing every remaining write', async () => {
    const r = rig();
    r.docket.ingest([...claim, E.filed(2), E.precheck(2, 1, 1), E.ruling(2, 1, 1, NOV + 7300)]);
    r.io.failWith.push(new Error('401 unauthorized'));
    const out = await r.docket.flush();
    expect(out.failed).toBe(1);
    expect(r.docket.writeStatus(cid(2))?.writeStatus).toBe('pending');
  });
});
