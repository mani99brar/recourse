import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Sim, encodeLog } from './helpers/encode.js';
import { CASE_DEADLINE, FEE, PLATFORM, SHOP, SHOP2, buildClaim, fakeReader, h32, ingest } from './helpers/fixtures.js';
import { harness } from './helpers/service.js';
import { TtlCache } from '../src/live.js';

function multi() {
  const sim = new Sim();
  const a = buildClaim(sim, 'finding_made', 1);
  sim.tick(50);
  const b = buildClaim(sim, 'settled', 2);
  sim.tick(50);
  const c = buildClaim(sim, 'window_lapsed', 3, { shop: SHOP2 });
  sim.tick(50);
  const d = buildClaim(sim, 'closed_uncontested', 4);
  const store = new Store();
  ingest(store, sim);
  for (const x of [a, b, c, d]) if (x.live) store.live.set(x.claimId, x.live);
  return { sim, store, a, b, c, d };
}

describe('escrow has one source', () => {
  it('the party figure equals the sum over its open claims, and rows equal the detail', async () => {
    const { store, a, c, sim } = multi();
    // No vault read: the figure comes from the index.
    const h = harness({ store, now: Number(sim.t) + 1, reader: null });
    const rows = await h.svc.claimRows();
    const held = rows.filter((r) => r.shop === SHOP && r.escrow.fate === 'held');
    const party = await h.svc.party(SHOP);
    expect(party.escrowOpen).toBe(held.reduce((n, r) => n + r.escrow.amount, 0n));
    expect(party.escrowOpen).toBe(FEE); // only claim a still holds its fee for SHOP
    // The platform's page does not count its shops' court fees as its own.
    expect((await h.svc.party(PLATFORM)).escrowOpen).toBe(0n);
    for (const x of [a, c]) {
      const row = rows.find((r) => r.claimId === x.claimId)!;
      const d = await h.svc.claimDetail(x.claimId);
      expect(d.escrow).toEqual(row.escrow);
      expect(d.money.escrow).toEqual(row.escrow);
    }
    // Settled and closed claims show where the fee went.
    expect(rows.find((r) => r.statusKey === 'closed_uncontested')!.escrow.fate).toBe('refunded');
    expect(rows.find((r) => r.statusKey === 'settled')!.escrow.fate).toBe('kept_by_pool');
  });

  it('takes the vault figure when the vault was read, and shows no escrow for a fee it has not indexed', async () => {
    const { store, sim } = multi();
    const reader = fakeReader({
      async party(a) {
        return { deposit: 100_000_000n, required: 10_000_000n, credit: 0n, topUpDeadline: 0n, inGoodStanding: true, openClaims: 1n, exitRequestedAt: 0n, shopEscrow: a === SHOP ? 3n * FEE : 0n };
      },
    });
    const h = harness({ store, now: Number(sim.t) + 1, reader });
    expect((await h.svc.party(SHOP)).escrowOpen).toBe(3n * FEE);
    expect((await h.svc.party(PLATFORM)).escrowOpen).toBe(0n);

    // A claim whose FeeEscrowed is not indexed holds nothing, whatever the court fee is now.
    const bare = new Sim();
    const b = buildClaim(bare, 'finding_made', 9);
    const feeTopic = encodeLog('vault', 'FeeEscrowed', { claimId: b.claimId, shop: SHOP, amount: FEE }).topics[0];
    bare.logs = bare.logs.filter((l) => l.raw.topics[0] !== feeTopic);
    const s = new Store();
    ingest(s, bare);
    const row = (await harness({ store: s, now: Number(bare.t) + 1 }).svc.claimRows()).find((r) => r.claimId === b.claimId)!;
    expect(row.escrow).toEqual({ amount: 0n, fate: 'none' });
  });
});

describe('top-up reads the vault, never the claim', () => {
  it('shows the deadline from the vault view and zero once the deposit is restored', async () => {
    const { store, sim } = multi();
    let deadline = 1_700_900_000n;
    const reader = fakeReader({
      async party() {
        return { deposit: deadline === 0n ? 100_000_000n : 1_000_000n, required: 10_000_000n, credit: 0n, topUpDeadline: deadline, inGoodStanding: deadline === 0n, openClaims: 1n, exitRequestedAt: 0n, shopEscrow: 0n };
      },
    });
    const h = harness({ store, now: Number(sim.t) + 1, reader });
    expect((await h.svc.party(PLATFORM)).topUpDeadline).toBe(1_700_900_000n);
    expect(((await h.svc.claimsResponse(PLATFORM)) as { standing: { topUpDeadline: bigint } }).standing.topUpDeadline).toBe(1_700_900_000n);
    deadline = 0n; // the platform posts a deposit
    expect((await h.svc.party(PLATFORM)).topUpDeadline).toBe(0n);
    expect(((await h.svc.claimsResponse(PLATFORM)) as { standing: { topUpDeadline: bigint } }).standing.topUpDeadline).toBe(0n);
    const detail = JSON.stringify((await h.svc.claimDetail((await h.svc.claimRows())[0]!.claimId)), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(detail).not.toMatch(/topUp/i);
  });
});

describe('worklists', () => {
  it('puts standing first and groups every claim exactly once', async () => {
    const { store, sim } = multi();
    const h = harness({ store, now: Number(sim.t) + 1 });
    const r = (await h.svc.claimsResponse(SHOP)) as { standing: { role: string }; groups: Record<string, string[]>; rows: { claimId: string }[] };
    expect(r.standing.role).toBe('shop');
    const all = Object.entries(r.groups).filter(([k]) => k !== 'owedToYou').flatMap(([, v]) => v);
    expect(all.sort()).toEqual(r.rows.map((x) => x.claimId).sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('sorts a window-lapsed claim into openToAnyone and owedToYou for the shop', async () => {
    const { store, sim, c } = multi();
    const h = harness({ store, now: Number(sim.t) + 1_000_000 });
    const r = (await h.svc.claimsResponse(SHOP2)) as { groups: Record<string, string[]> };
    expect(r.groups.openToAnyone).toContain(c.claimId);
    expect(r.groups.owedToYou).toContain(c.claimId);
  });

  it('rejects a bad address and a bad id', async () => {
    const { store } = multi();
    const h = harness({ store });
    await expect(h.svc.claimsResponse('nope')).rejects.toMatchObject({ status: 400 });
    await expect(h.svc.claimDetail('0x12')).rejects.toMatchObject({ status: 400 });
    await expect(h.svc.claimDetail(h32(0xdead))).rejects.toMatchObject({ status: 404 });
    await expect(h.svc.party('zzz')).rejects.toMatchObject({ status: 400 });
  });
});

describe('party standing', () => {
  it('names a known party and reports an unknown address as unknown', async () => {
    const { store } = multi();
    const h = harness({ store });
    expect((await h.svc.party(PLATFORM)).role).toBe('platform');
    expect((await h.svc.party('0x' + '99'.repeat(20))).role).toBe('unknown');
  });

  it('reads the vault only for known parties and addresses seen in a claim, never for any other address', async () => {
    const { store } = multi();
    const reader = fakeReader();
    const h = harness({ store, reader });
    for (let i = 0; i < 50; i++) {
      const stranger = '0x' + (0xa000 + i).toString(16).padStart(40, '0');
      const p = await h.svc.party(stranger);
      expect(p).toMatchObject({ role: 'unknown', balance: null, inGoodStanding: null, openClaims: 0 });
      await h.svc.claimsResponse(stranger);
    }
    expect(reader.calls.filter((c) => c.startsWith('party:'))).toEqual([]);
    expect((await h.svc.party(PLATFORM)).inGoodStanding).toBe(true);
    // An address that is not in the parties file but filed a claim is still read.
    const h2 = harness({ store, reader, parties: null });
    expect((await h2.svc.party(SHOP)).balance).toBe(100_000_000n);
    expect(reader.calls.filter((c) => c.startsWith('party:')).length).toBe(2);
  });
});

describe('the live-read cache is bounded', () => {
  it('holds at most maxEntries keys, dropping expired ones and then the oldest', async () => {
    let now = 0;
    const c = new TtlCache<number>(1000, () => now, 3);
    for (let i = 0; i < 10; i++) await c.get(`k${i}`, async () => i);
    expect(c.size).toBe(3);
    expect(await c.get('k9', async () => -1)).toBe(9);
    expect(await c.get('k0', async () => -1)).toBe(-1);
    now = 5000;
    await c.get('fresh', async () => 1);
    expect(c.size).toBeLessThanOrEqual(3);
    // A failed load is not kept, and does not remove a newer entry for the same key.
    await expect(c.get('bad', async () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(await c.get('bad', async () => 2)).toBe(2);
  });
});

describe('the court case read and its events', () => {
  function atCourt() {
    const sim = new Sim();
    const b = buildClaim(sim, 'at_court', 1);
    return { sim, b };
  }

  it('the case events win over an older case read, and the Kleros reads still show', async () => {
    const { sim, b } = atCourt();
    sim.tick(900);
    sim.arb('RulingFinal', { claimId: b.claimId, disputeId: 901n, ruling: 1, attempts: 1 });
    const store = new Store();
    ingest(store, sim);
    store.live.set(b.claimId, b.live!); // read while the case was still opened
    const h = harness({ store, now: Number(sim.t) + 10 });
    const d = await h.svc.claimDetail(b.claimId);
    expect(d.court.state).toBe('ruled');
    expect(d.court.disputeIds[0]).toBe(901n);
    expect(d.court.currentRuling).toBe(1n);
  });

  it('a later attempt in the events wins over a read of the first attempt being refiled', async () => {
    const { sim, b } = atCourt();
    sim.tick(600);
    sim.arb('RefileNeeded', { claimId: b.claimId });
    sim.tick(60);
    sim.arb('CaseOpened', { claimId: b.claimId, disputeId: 951n, attempt: 2 });
    const store = new Store();
    ingest(store, sim);
    store.live.set(b.claimId, { ...b.live!, caseView: { ...b.live!.caseView!, state: 3 } });
    const h = harness({ store, now: Number(sim.t) + 10 });
    const d = await h.svc.claimDetail(b.claimId);
    expect(d.court.state).toBe('opened');
    expect(d.court.attempts).toBe(2);
    expect(d.court.disputeIds).toEqual([901n, 951n]);
  });

  it('the case events keep the read expiry, so a refile stays open until expiresAt - caseDeadline', async () => {
    const { sim, b } = atCourt();
    sim.tick(600);
    sim.arb('RefileNeeded', { claimId: b.claimId });
    const now = sim.t + CASE_DEADLINE + 60n; // past ruledAt + caseDeadline, the rule without an expiry
    const expiresAt = now + CASE_DEADLINE + 600n;
    const store = new Store();
    ingest(store, sim);
    // The last case read is from before the RefileNeeded; the reads since failed.
    store.live.set(b.claimId, { ...b.live!, caseView: { ...b.live!.caseView!, expiresAt } });
    const h = harness({ store, now: Number(now) });
    const d = await h.svc.claimDetail(b.claimId);
    expect(d.court.state).toBe('refile_pending');
    expect(d.statusKey).toBe('refused_once');
    expect(d.nextCall).toBe('refile');
    expect(d.deadline).toBe(expiresAt - CASE_DEADLINE);
  });

  it('a case read further along than the events still wins', async () => {
    const { sim, b } = atCourt();
    const store = new Store();
    ingest(store, sim);
    store.live.set(b.claimId, { ...b.live!, caseView: { ...b.live!.caseView!, state: 4, ruling: 2, ruledAt: sim.t } });
    const h = harness({ store, now: Number(sim.t) + 10 });
    expect((await h.svc.claimDetail(b.claimId)).court.state).toBe('ruled');
  });
});
