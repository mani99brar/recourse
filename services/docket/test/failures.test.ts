import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { ReviewPort } from '../src/docket.js';
import type { CaseRow } from '../src/schema.js';
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

  it('does not create again when the "did it land?" lookup fails', async () => {
    const r = rig();
    r.docket.ingest(claim);
    r.io.loseResponse = true; // the create lands, the response is lost
    await r.docket.flush();
    const cases = () => [...r.io.entities.values()].filter((e) => e.schema === 'case');
    expect(cases()).toHaveLength(1);
    expect(r.docket.writeStatus(cid(1))?.writeStatus).toBe('failed');

    r.clock.t += 601;
    r.io.failQueries.push(new Error('connection reset')); // the lookup before the retry fails
    const out = await r.docket.flush();
    expect(cases()).toHaveLength(1);
    expect(out.failed).toBe(1);

    await r.docket.flush(); // the next pass looks again and adopts it
    expect(cases()).toHaveLength(1);
    expect(r.docket.writeStatus(cid(1))?.writeStatus).toBe('written');
  });
});

describe('reason pinning', () => {
  function recordingReviews() {
    const seen: { claimId: Hex; row: CaseRow }[][] = [];
    const port: ReviewPort = { process: async (cases) => void seen.push([...cases]), statusOf: () => ({ platform: { status: 'none' }, shop: { status: 'none' } }) };
    return { port, seen };
  }

  it('a failed pin is retried and the case patched with the CID; reviews wait for it', async () => {
    let fails = 1;
    const pinner = { pin: async () => (fails-- > 0 ? Promise.reject(new Error('pin service 502')) : 'bafyreason') };
    const reviews = recordingReviews();
    const r = rig({ pinner, reviews: reviews.port });
    r.docket.ingest(claim);
    await r.docket.flush();
    const entity = () => [...r.io.entities.values()].find((e) => e.schema === 'case')!;
    expect(r.docket.writeStatus(cid(1))?.writeStatus).toBe('written');
    expect(entity().values.reasonCid).toBe('');
    expect(reviews.seen.at(-1)).toEqual([]); // no review without the reason's CID

    r.clock.t += 601;
    await r.docket.flush();
    expect(entity().values.reasonCid).toBe('bafyreason');
    expect(reviews.seen.at(-1)?.map((c) => c.row.reasonCid)).toEqual(['bafyreason']);
  });

  it('pins again a reason an older docket journaled as empty after a failed pin', async () => {
    const r = rig({ pinner: { pin: async () => Promise.reject(new Error('pin service down')) } });
    r.docket.ingest(claim);
    r.journal.append({ t: 'reason', claimId: cid(1), cid: '' });
    const again = r.reopen({ pinner: { pin: async () => 'bafylater' } });
    await again.flush();
    expect([...r.io.entities.values()].find((e) => e.schema === 'case')!.values.reasonCid).toBe('bafylater');
  });

  it('with pinning off the case and its reviews carry no CID, and nothing is pinned again', async () => {
    const reviews = recordingReviews();
    const r = rig({ reviews: reviews.port });
    r.docket.ingest(claim);
    await r.docket.flush();
    await r.docket.flush();
    expect(reviews.seen.at(-1)?.map((c) => c.row.reasonCid)).toEqual(['']);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(r.journalPath, 'utf8').split('\n').filter((l) => l.includes('"t":"reason"'))).toHaveLength(1);
  });
});
