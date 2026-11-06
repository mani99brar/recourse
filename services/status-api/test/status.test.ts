import { STATUS_KEYS } from '@recourse/shared';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { STAGES, TIMEOUT, WINDOW, buildClaim, fakeReader, ingest, type Stage } from './helpers/fixtures.js';
import { refreshLive, refreshPreChecks } from '../src/live.js';
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
    // Hedera takes expireClaim only after the timeout: nothing to send until then.
    expect(r.nextCall).toBeNull();
    expect(r.deadline).not.toBeNull();
    h.clock.now = Number(r.deadline) + 1;
    expect((await h.svc.claimRows())[0]!.nextCall).toBe('expireClaim');
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

  it('past the timeout, a case Arbitrum has not been read for gets no expiry advice', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'at_court', 1);
    const store = new Store();
    // A fresh store serving before Arbitrum caught up: the Hedera events only, no case read.
    ingest(store, sim, (chain) => chain === 'hedera');
    store.live.set(b.claimId, { ...b.live!, caseView: null });
    const preCheckedAt = store.eventsOf(b.claimId).find((e) => e.name === 'PreCheckRecorded')!.time;
    const now = Number(preCheckedAt + TIMEOUT + 1n);
    const h = harness({ store, now });
    const row = async () => (await h.svc.claimRows())[0]!;
    expect(await row()).toMatchObject({ statusKey: 'at_court', nextActor: 'none', nextCall: null, deadline: null });
    expect((await h.svc.claimDetail(b.claimId)).nextCall).toBeNull();
    // Arbitrum read through to now and no case on it: nothing reached the court, so expiry is right.
    store.status.arbitrum.indexedThrough = now;
    expect((await row()).nextCall).toBe('expireClaim');
    // The Arbitrum source failing again: unknown again.
    store.status.arbitrum.failing = true;
    expect((await row()).nextCall).toBeNull();
    // A fresh caseOf read that finds no case settles it, whatever the events say.
    store.live.set(b.claimId, { ...b.live!, caseView: { ...b.live!.caseView!, state: 0, attempts: 0, disputeIds: [0n, 0n] }, caseReadAt: now - 5 });
    expect((await row()).nextCall).toBe('expireClaim');
  });

  it('past the timeout, an old read of an open case is not taken as current', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'at_court', 1);
    const store = new Store();
    ingest(store, sim);
    const preCheckedAt = store.eventsOf(b.claimId).find((e) => e.name === 'PreCheckRecorded')!.time;
    const now = Number(preCheckedAt + TIMEOUT + 1n);
    store.status.arbitrum.failing = true;
    // Read as Opened half an hour ago; Arbitrum has failed since, so it may have been ruled.
    store.live.set(b.claimId, { ...b.live!, caseReadAt: now - 1_800 });
    const h = harness({ store, now });
    expect((await h.svc.claimRows())[0]).toMatchObject({ statusKey: 'at_court', nextActor: 'court', nextCall: null, deadline: null });
    // Read as Opened a few seconds ago: still being decided, nothing on its way, expiry stands.
    store.live.set(b.claimId, { ...b.live!, caseReadAt: now - 5 });
    expect((await h.svc.claimRows())[0]).toMatchObject({ statusKey: 'stuck', nextCall: 'expireClaim' });
  });

  it('a successful case read is timed; a failed one leaves the time as it was', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'at_court', 1);
    const store = new Store();
    ingest(store, sim);
    await refreshLive(store, fakeReader(), () => 1_000);
    expect(store.live.get(b.claimId)?.caseReadAt).toBeUndefined();
    await refreshLive(store, fakeReader({ caseOf: async () => b.live!.caseView! }), () => 2_000);
    expect(store.live.get(b.claimId)?.caseReadAt).toBe(2_000);
    await refreshLive(store, fakeReader(), () => 3_000);
    expect(store.live.get(b.claimId)?.caseReadAt).toBe(2_000);
    expect(Store.fromJSON(store.toJSON())!.live.get(b.claimId)?.caseReadAt).toBe(2_000);
  });
});

describe('preCheckedAt comes from the contract, not the mirror', () => {
  it("the contest window ends where the chain's ends, though the mirror time is 2 s later", async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'finding_made', 1);
    const store = new Store();
    ingest(store, sim);
    const mirrorAt = store.eventsOf(b.claimId).find((e) => e.name === 'PreCheckRecorded')!.time;
    const chainAt = mirrorAt - 2n; // block.timestamp, as getClaim returns it
    const reader = fakeReader({ preCheckedAt: async () => chainAt });
    const h = harness({ store, now: Number(chainAt + WINDOW), reader });
    // Before the read: the mirror time stands in.
    expect((await h.svc.claimDetail(b.claimId)).contest.windowEndsAt).toBe(mirrorAt + WINDOW);
    await refreshPreChecks(store, reader, () => 0);
    const d = await h.svc.claimDetail(b.claimId);
    expect(d.contest.windowEndsAt).toBe(chainAt + WINDOW);
    expect(d.precheck!.preCheckedAt).toBe(chainAt);
    expect(d.deadline).toBe(chainAt + WINDOW);
    expect(d.statusKey).toBe('finding_made');
    // One second past the chain's window the contest is closed, as contest() would revert.
    h.clock.now = Number(chainAt + WINDOW + 1n);
    expect((await h.svc.claimDetail(b.claimId)).statusKey).toBe('window_lapsed');
    // Read once: a later poll does not read it again.
    const n = reader.calls.filter((c) => c.startsWith('preCheckedAt')).length;
    await refreshPreChecks(store, reader, () => 0);
    expect(reader.calls.filter((c) => c.startsWith('preCheckedAt')).length).toBe(n);
  });

  it('a claim the chain does not show as pre-checked yet keeps the mirror time and is read again', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'finding_made', 1);
    const store = new Store();
    ingest(store, sim);
    const reader = fakeReader({ preCheckedAt: async () => 0n });
    await refreshPreChecks(store, reader, () => 0);
    expect(store.live.get(b.claimId)?.preCheckedAt).toBeUndefined();
    await refreshPreChecks(store, reader, () => 0);
    expect(reader.calls.filter((c) => c.startsWith('preCheckedAt')).length).toBe(2);
  });

  it('an older snapshot without the field still loads, and a new one keeps it', () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'finding_made', 1);
    const store = new Store();
    ingest(store, sim);
    store.live.set(b.claimId, { caseView: null, exec: {}, kleros: {}, at: 1, preCheckedAt: 123n });
    const back = Store.fromJSON(store.toJSON())!;
    expect(back.live.get(b.claimId)!.preCheckedAt).toBe(123n);
    const old = JSON.parse(store.toJSON());
    delete old.live[0][1].preCheckedAt;
    expect(Store.fromJSON(JSON.stringify(old))!.live.get(b.claimId)!.preCheckedAt).toBeUndefined();
  });
});
