import { describe, expect, it } from 'vitest';
import { addressBook } from '@recourse/shared';
import { refreshLive } from '../src/live.js';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { buildClaim, fakeReader, h32, ingest } from './helpers/fixtures.js';
import { harness } from './helpers/service.js';

describe('stuck detection', () => {
  async function key(stage: 'stuck_failed' | 'stuck_untouched' | 'at_court_fresh') {
    const sim = new Sim();
    const b = buildClaim(sim, stage, 1);
    const store = new Store();
    ingest(store, sim);
    store.live.set(b.claimId, b.live!);
    const h = harness({ store, now: Number(b.now) });
    return (await h.svc.claimRows())[0]!;
  }
  it('a FAILURE state is stuck', async () => {
    expect((await key('stuck_failed')).statusKey).toBe('stuck');
  });
  it('an UNTOUCHED message past stuckAfter is stuck and offers a resend', async () => {
    const r = await key('stuck_untouched');
    expect(r.statusKey).toBe('stuck');
    expect(r.nextCall).toBe('resend');
  });
  it('an UNTOUCHED message inside stuckAfter is still at court', async () => {
    expect((await key('at_court_fresh')).statusKey).toBe('at_court');
  });
  it('does not call a claim stuck when the execution state was never read', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'stuck_untouched', 1);
    const store = new Store();
    ingest(store, sim);
    const h = harness({ store, now: Number(b.now) + 4_000 });
    expect((await h.svc.claimRows())[0]!.statusKey).toBe('at_court');
  });
  it('an older failed send does not call a claim stuck while its resend is not read yet', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'stuck_failed', 1);
    sim.tick(1_900);
    const resent = h32(0x5f01);
    sim.hedera('claims', 'SentToCourt', { claimId: b.claimId, messageId: resent });
    const store = new Store();
    ingest(store, sim);
    store.live.set(b.claimId, b.live!); // the first send FAILURE, the resend not read
    const h = harness({ store, now: Number(sim.t) + 60 });
    expect((await h.svc.claimRows())[0]!.statusKey).toBe('at_court');
    // Once the resend is read, it decides.
    store.live.set(b.claimId, { ...b.live!, exec: { ...b.live!.exec, [resent]: 3 } });
    expect((await h.svc.claimRows())[0]!.statusKey).toBe('stuck');
  });
});

describe('OffRamp direction', () => {
  it('reads the outbound message on the Arbitrum OffRamp and the ruling on the Hedera OffRamp', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'at_court', 1);
    // The ruling is relayed back from Arbitrum.
    sim.arb('RulingFinal', { claimId: b.claimId, disputeId: 901n, ruling: 1, attempts: 1 });
    sim.arb('RulingRelayed', { claimId: b.claimId, disputeId: 901n, ruling: 1, messageId: b.backMsg });
    const store = new Store();
    ingest(store, sim);
    const seen: { chain: string; id: string }[] = [];
    const reader = fakeReader({
      async caseOf() {
        return b.live!.caseView!;
      },
      async executionState(chain, id) {
        seen.push({ chain, id });
        return 2;
      },
    });
    await refreshLive(store, reader, () => 0);
    expect(seen).toContainEqual({ chain: 'arbitrum', id: b.sendMsg });
    expect(seen).toContainEqual({ chain: 'hedera', id: b.backMsg });
    expect(seen).not.toContainEqual({ chain: 'hedera', id: b.sendMsg });
    expect(seen).not.toContainEqual({ chain: 'arbitrum', id: b.backMsg });
  });

  it('keeps the address book ramps straight: Arbitrum 0xC932, Hedera 0x7752', () => {
    expect(addressBook.arbitrum.offRamp.toLowerCase()).toContain('c93218eb');
    expect(addressBook.hedera.offRamp.toLowerCase()).toContain('7752798d');
  });

  it('does not read a message again once it succeeded', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'at_court', 1);
    const store = new Store();
    ingest(store, sim);
    let n = 0;
    const reader = fakeReader({
      async caseOf() {
        return b.live!.caseView!;
      },
      async executionState() {
        n++;
        return 2;
      },
    });
    await refreshLive(store, reader, () => 0);
    await refreshLive(store, reader, () => 0);
    expect(n).toBe(1);
  });
});
