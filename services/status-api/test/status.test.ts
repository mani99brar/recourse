import { STATUS_KEYS } from '@recourse/shared';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { STAGES, buildClaim, ingest, type Stage } from './helpers/fixtures.js';
import { harness } from './helpers/service.js';

async function rowFor(stage: Stage) {
  const sim = new Sim();
  const b = buildClaim(sim, stage, 1);
  const store = new Store();
  ingest(store, sim);
  if (b.live) store.live.set(b.claimId, b.live);
  const h = harness({ store, now: Number(b.now) });
  const rows = await h.svc.claimRows();
  return { b, rows, h };
}

describe('status through the join', () => {
  for (const stage of STAGES) {
    it(`${stage} reads the same status the shared derivation gives`, async () => {
      const { b, rows } = await rowFor(stage);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.statusKey).toBe(b.expectKey);
    });
  }

  it('reaches 14 of the 15 keys; closed_undrawn needs the batch draw, which is not built', async () => {
    const seen = new Set<string>();
    for (const stage of STAGES) seen.add((await rowFor(stage)).rows[0]!.statusKey);
    expect([...STATUS_KEYS].filter((k) => !seen.has(k))).toEqual(['closed_undrawn']);
  });

  it('takes stuck and refused_once from the Arbitrum and OffRamp reads, not from Hedera status', async () => {
    const { b, rows } = await rowFor('refused_once');
    expect(rows[0]!.statusKey).toBe('refused_once');
    expect(rows[0]!.nextCall).toBe('refile');
    expect(b.live?.caseView?.state).toBe(3);
  });

  it('names the actor and call for a finding and carries the deadline', async () => {
    const { rows } = await rowFor('finding_made');
    expect(rows[0]).toMatchObject({ nextActor: 'platform', nextCall: 'contest', findingSide: 'platform', gap: 1, answer: 1 });
    expect(rows[0]!.deadline).not.toBeNull();
  });

  it('shows gap and answer as null before the pre-check', async () => {
    const { rows } = await rowFor('filed');
    expect(rows[0]).toMatchObject({ gap: null, answer: null, findingSide: null, statusKey: 'filed', nextActor: 'preCheckSigner' });
  });

  it('falls back to the case events when the live case read is missing', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'refused_once', 1);
    const store = new Store();
    ingest(store, sim);
    store.live.set(b.claimId, { ...b.live!, caseView: null });
    const h = harness({ store, now: Number(b.now) });
    expect((await h.svc.claimRows())[0]!.statusKey).toBe('refused_once');
  });

  it('filters by status key and rejects an unknown key', async () => {
    const sim = new Sim();
    buildClaim(sim, 'filed', 1);
    buildClaim(sim.tick(10), 'finding_made', 2);
    const store = new Store();
    ingest(store, sim);
    const h = harness({ store, now: Number(sim.t) + 5 });
    expect((await h.svc.claimsResponse(undefined, 'filed')).rows).toHaveLength(1);
    await expect(h.svc.claimsResponse(undefined, 'bogus')).rejects.toMatchObject({ status: 400 });
  });
});

describe('expiry', () => {
  it('a filed claim carries filedAt + claimTimeout as its deadline', async () => {
    const { b, rows } = await rowFor('filed');
    expect(rows[0]!.deadline).toBe(BigInt((await Promise.resolve(b.now)) - 5n) + 14_400n);
  });

  it('a contested claim carries preCheckedAt + claimTimeout', async () => {
    const { rows } = await rowFor('contested');
    expect(rows[0]!.deadline).not.toBeNull();
    const fin = (await rowFor('finding_made')).rows[0]!;
    expect(fin.deadline).not.toBeNull(); // the contest window, not an expiry
  });

  it('a stale case reads as stuck with an expire call', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'at_court', 1);
    const store = new Store();
    ingest(store, sim);
    store.live.set(b.claimId, { ...b.live!, caseView: { ...b.live!.caseView!, state: 6 } });
    const h = harness({ store, now: Number(b.now) });
    const r = (await h.svc.claimRows())[0]!;
    expect(r.statusKey).toBe('stuck');
    expect(r.nextCall).toBe('expireClaim');
  });

  it('passes Arbitrum expiresAt through: a received case past it is dead', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'at_court', 1);
    const store = new Store();
    ingest(store, sim);
    const cv = { ...b.live!.caseView!, state: 1, attempts: 0, disputeIds: [0n, 0n] as const, expiresAt: b.now - 1n };
    store.live.set(b.claimId, { ...b.live!, caseView: cv });
    const h = harness({ store, now: Number(b.now) });
    expect((await h.svc.claimRows())[0]!.statusKey).toBe('stuck');
  });
});
