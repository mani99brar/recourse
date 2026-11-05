import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { FEE, PLATFORM, SHOP, SHOP2, buildClaim, fakeReader, h32, ingest } from './helpers/fixtures.js';
import { harness } from './helpers/service.js';

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
    const h = harness({ store, now: Number(sim.t) + 1 });
    const rows = await h.svc.claimRows();
    const held = rows.filter((r) => r.shop === SHOP && r.escrow.fate === 'held');
    const party = await h.svc.party(SHOP);
    expect(party.escrowOpen).toBe(held.reduce((n, r) => n + r.escrow.amount, 0n));
    expect(party.escrowOpen).toBe(FEE); // only claim a still holds its fee for SHOP
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
});
