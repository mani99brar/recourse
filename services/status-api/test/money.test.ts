import { claimIdOf, orderIdOf, settleOutcome, type SettleInput } from '@recourse/shared';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { CLAIMS, FEE, PLATFORM, SHOP, h32, ingest, nonce, refsFor, WINDOW } from './helpers/fixtures.js';
import { harness } from './helpers/service.js';

const hp = { handlingBase: 15_000_000n, handlingBps: 500n, handlingCap: 40_000_000n };
const basket = 60_000_000n;
const netLoss = 50_000_000n;

interface Case {
  name: string;
  ruling: number;
  attempts: number;
  gap: number;
  answer: number;
  deposit: bigint;
  row: string;
}

const CASES: Case[] = [
  { name: 'ruled for the platform, deposit covers it', ruling: 1, attempts: 1, gap: 1, answer: 1, deposit: 500_000_000n, row: 'ruled_platform' },
  { name: 'ruled for the platform, deposit short', ruling: 1, attempts: 1, gap: 1, answer: 1, deposit: 20_000_000n, row: 'ruled_platform' },
  { name: 'ruled for the platform, platform has no deposit', ruling: 1, attempts: 1, gap: 1, answer: 1, deposit: 0n, row: 'ruled_platform' },
  { name: 'ruled for the shop side', ruling: 2, attempts: 1, gap: 1, answer: 1, deposit: 500_000_000n, row: 'ruled_shop' },
  { name: 'ruled neither, flagged gap', ruling: 3, attempts: 1, gap: 1, answer: 1, deposit: 500_000_000n, row: 'ruled_neither_flagged' },
  { name: 'ruled neither, other gap', ruling: 3, attempts: 1, gap: 255, answer: 2, deposit: 500_000_000n, row: 'ruled_neither_other' },
  { name: 'refused twice, answer applies', ruling: 0, attempts: 2, gap: 1, answer: 1, deposit: 500_000_000n, row: 'zero_twice_answer' },
  { name: 'refused twice, unresolved', ruling: 0, attempts: 2, gap: 255, answer: 0, deposit: 500_000_000n, row: 'zero_twice_unresolved' },
];

function ruledSim(c: Case, settle: boolean) {
  const sim = new Sim();
  const orderId = orderIdOf(PLATFORM, SHOP, nonce(1));
  const claimId = claimIdOf(296, CLAIMS, orderId);
  sim.hedera('vault', 'FeeEscrowed', { claimId, shop: SHOP, amount: FEE });
  sim.hedera('claims', 'ClaimFiled', { claimId, orderId, shop: SHOP, platform: PLATFORM, refs: refsFor(), basketUsdc: basket, netLossUsdc: netLoss, filedAt: sim.t });
  sim.tick(30).hedera('claims', 'PreCheckRecorded', { claimId, gap: c.gap, answer: c.answer, packHash: h32(9) });
  sim.tick(60).hedera('claims', 'Contested', { claimId, by: PLATFORM });
  sim.tick(20).hedera('claims', 'SentToCourt', { claimId, messageId: h32(0x51) });
  sim.tick(2000).hedera('claims', 'RulingReceived', { claimId, disputeId: 7n, ruling: c.ruling, attempts: c.attempts, messageId: h32(0x52) });
  const mirror = settleOutcome({ outcome: 'ruled', ruling: c.ruling, attempts: c.attempts, gap: c.gap as 0, answer: c.answer as 0, basketUsdc: basket, netLossUsdc: netLoss, feeUsdc: FEE, params: hp } as SettleInput);
  if (settle) {
    const paid = mirror.toShop < c.deposit ? mirror.toShop : c.deposit;
    sim.tick(20).hedera('claims', 'Settled', { claimId, outcome: mirror.settledOutcome ?? 0, toShop: mirror.toShop, toPool: mirror.toPool });
    sim.hedera('vault', 'OutcomeApplied', { claimId, platform: PLATFORM, shop: SHOP, paid, refund: mirror.refundToShop, toPool: mirror.toPool });
    if (mirror.toShop > paid) sim.hedera('vault', 'Shortfall', { claimId, platform: PLATFORM, amount: mirror.toShop - paid });
  }
  return { sim, mirror, claimId };
}

describe('money', () => {
  for (const c of CASES) {
    it(`projects the settle row before Settled and balances after: ${c.name}`, async () => {
      // Before: ruled, not settled. The projection equals what Settled will carry.
      const before = ruledSim(c, false);
      const s1 = new Store();
      ingest(s1, before.sim);
      const r1 = (await harness({ store: s1, now: Number(before.sim.t) + 10 }).svc.claimRows())[0]!;
      expect(before.mirror.row).toBe(c.row);
      expect(r1.owed).toBe(before.mirror.toShop);
      expect(r1.paid).toBeNull();
      expect(r1.credited).toBeNull();
      expect(r1.notCovered).toBeNull();
      expect(r1.escrow).toEqual({ amount: FEE, fate: 'held' });

      // After: Settled with the deposit applied.
      const after = ruledSim(c, true);
      const s2 = new Store();
      ingest(s2, after.sim);
      const r2 = (await harness({ store: s2, now: Number(after.sim.t) + 10 }).svc.claimRows())[0]!;
      expect(r2.statusKey).toBe(c.row === 'zero_twice_unresolved' ? 'unresolved' : 'settled');
      expect(r2.owed).toBe(after.mirror.toShop);
      expect(r2.owed).toBe(r2.paid! + r2.notCovered!);
      expect(r2.credited).toBe(r2.paid! + after.mirror.refundToShop);
      expect(r2.escrow.amount).toBe(FEE);
    });
  }

  it('shows a platform with no deposit as paid 0 and notCovered = owed', async () => {
    const c = CASES[2]!;
    const { sim, mirror } = ruledSim(c, true);
    const store = new Store();
    ingest(store, sim);
    const r = (await harness({ store, now: Number(sim.t) + 1 }).svc.claimRows())[0]!;
    expect(r.paid).toBe(0n);
    expect(r.notCovered).toBe(mirror.toShop);
  });

  it('projects an uncontested close once the window lapses, and nothing before', async () => {
    const sim = new Sim();
    const orderId = orderIdOf(PLATFORM, SHOP, nonce(2));
    const claimId = claimIdOf(296, CLAIMS, orderId);
    sim.hedera('vault', 'FeeEscrowed', { claimId, shop: SHOP, amount: FEE });
    sim.hedera('claims', 'ClaimFiled', { claimId, orderId, shop: SHOP, platform: PLATFORM, refs: refsFor(), basketUsdc: basket, netLossUsdc: netLoss, filedAt: sim.t });
    sim.tick(10).hedera('claims', 'PreCheckRecorded', { claimId, gap: 1, answer: 1, packHash: h32(9) });
    const checked = sim.t;
    const store = new Store();
    ingest(store, sim);
    const inside = (await harness({ store, now: Number(checked + 5n) }).svc.claimRows())[0]!;
    expect(inside.owed).toBeNull();
    const lapsed = (await harness({ store, now: Number(checked + WINDOW + 1n) }).svc.claimRows())[0]!;
    expect(lapsed.statusKey).toBe('window_lapsed');
    expect(lapsed.owed).toBe(netLoss + 15_000_000n + 3_000_000n);
  });
});
