import { afterEach, describe, expect, it } from 'vitest';
import { recordHash, ZERO_HASH } from '@recourse/shared';
import { addLaterMessage, alertKinds, cleanupRigs, FILED_AT, journalRecords, makeRig, orderIdOf, refsOf, setupClaim } from './support.js';

afterEach(cleanupRigs);

describe('transient faults are retries, never absences', () => {
  for (const [name, mode] of [
    ['a 5xx', 503],
    ['a 429', 429],
    ['a timeout', 'timeout'],
  ] as const) {
    it(`${name} from the gateway sends nothing and settles no slot, then recovers`, async () => {
      const rig = makeRig();
      const { claimId } = setupClaim(rig, { later: true });
      rig.world.fail(/gateway\.example/, mode, 12); // every document read of the first two attempts
      const svc = await rig.start();

      await svc.tick();
      expect(svc.result(claimId)).toMatchObject({ state: 'seen', slots: [] });
      expect(rig.node.broadcasts).toHaveLength(0);

      rig.clock.advance(5_000);
      await svc.tick();
      expect(rig.node.broadcasts).toHaveLength(0);
      expect(svc.result(claimId)?.slots.some((s) => s.outcome === 'absent')).toBe(false);

      rig.clock.advance(60_000);
      await svc.tick();
      const view = svc.result(claimId);
      expect(view?.slots.map((s) => s.outcome)).toEqual(['held', 'held', 'held', 'held', 'held', 'held']);
      expect(rig.node.broadcasts).toHaveLength(1);
      svc.close();
    });
  }

  it('retries back off from 5 s, doubling to a 60 s cap', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    rig.world.fail(/gateway\.example/, 503, 1000);
    const svc = await rig.start();
    const requests = () => rig.world.requests.filter((u) => u.includes('gateway.example')).length;
    await svc.tick();
    const base = requests();
    rig.clock.advance(4_000);
    await svc.tick();
    expect(requests()).toBe(base); // inside the 5 s backoff
    rig.clock.advance(1_000);
    await svc.tick();
    expect(requests()).toBeGreaterThan(base);
    // Walk the failures up; the gap between attempts never exceeds 60 s.
    for (let i = 0; i < 10; i++) {
      rig.clock.advance(60_000);
      const before = requests();
      await svc.tick();
      expect(requests()).toBeGreaterThan(before);
    }
    expect(svc.result(claimId)?.state).toBe('seen');
    svc.close();
  });

  it('a refs seq above what the mirror shows is a retry; it passes once the mirror has it', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    // The mirror has ingested the records but not the later message or the last record yet.
    rig.world.visibleUpTo = 5;
    const svc = await rig.start();
    await svc.tick();
    expect(svc.result(claimId)).toMatchObject({ state: 'seen', slots: [] });
    expect(rig.node.broadcasts).toHaveLength(0);

    rig.world.visibleUpTo = Infinity;
    rig.clock.advance(60_000);
    await svc.tick();
    expect(svc.result(claimId)?.slots.map((s) => s.outcome)).toEqual(['held', 'held', 'held', 'held', 'held', 'held']);
    expect(rig.node.broadcasts).toHaveLength(1);
    svc.close();
  });

  it('a refs seq the mirror never has keeps the claim retrying and alerts at ten minutes', async () => {
    const rig = makeRig();
    const orderId = orderIdOf(2);
    addLaterMessage(rig.world);
    const claimId = rig.world.fileClaim(orderId, refsOf(500n, { 3: { seq: 9999, hash: recordHash(new Uint8Array([1])) } }));
    rig.chain.claims.set(claimId, { status: 1, packHash: ZERO_HASH });
    const svc = await rig.start();
    for (let i = 0; i < 12; i++) {
      await svc.tick();
      rig.clock.advance(60_000);
    }
    expect(svc.result(claimId)).toMatchObject({ state: 'seen', slots: [] });
    expect(rig.node.broadcasts).toHaveLength(0);
    expect(alertKinds(rig)).toContain('precheck_stalled');
    svc.close();
  });

  it('the topic index lagging behind the filing: no slot is final until it has read past it', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true, omit: [4, 5] });
    // The mirror shows the first four records only; the later message and the packed/arrived slots are not visible yet.
    rig.world.visibleUpTo = 4;
    const svc = await rig.start();
    await svc.tick();
    expect(svc.result(claimId)).toMatchObject({ state: 'seen', slots: [] });
    expect(rig.node.broadcasts).toHaveLength(0);

    rig.world.visibleUpTo = Infinity;
    rig.clock.advance(60_000);
    await svc.tick();
    expect(svc.result(claimId)?.slots.map((s) => s.outcome)).toEqual(['held', 'held', 'held', 'held', 'absent', 'absent']);
    expect(rig.node.broadcasts).toHaveLength(1);
    svc.close();
  });

  it('a quiet topic: absent is final only after PRECHECK_QUIET_S past the filing', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { omit: [4, 5] }); // no message after the filing
    const svc = await rig.start();

    await svc.tick(); // filing + 30 s
    expect(svc.result(claimId)).toMatchObject({ state: 'seen', slots: [] });

    rig.clock.setSeconds(FILED_AT + 119n);
    await svc.tick();
    expect(svc.result(claimId)).toMatchObject({ state: 'seen', slots: [] });
    expect(rig.node.broadcasts).toHaveLength(0);

    // Past the quiet window the next refresh probes the tip, then the claim settles.
    rig.clock.setSeconds(FILED_AT + 200n);
    await svc.tick();
    expect(svc.result(claimId)?.slots.map((s) => s.outcome)).toEqual(['held', 'held', 'held', 'held', 'absent', 'absent']);
    expect(rig.node.broadcasts).toHaveLength(1);
    svc.close();
  });

  it('a probe taken before the quiet window ends does not settle an absence', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { omit: [4, 5] });
    const svc = await rig.start();
    rig.clock.setSeconds(FILED_AT + 100n);
    await svc.tick();
    rig.clock.setSeconds(FILED_AT + 125n);
    // The claim's own backoff is over; only a probe started after +120 s counts.
    await svc.tick();
    expect(svc.result(claimId)?.slots.length).toBe(6);
    svc.close();
  });

  it('alerts precheck_stalled after ten minutes of retrying and keeps retrying', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    rig.world.fail(/gateway\.example/, 503, 10_000);
    const svc = await rig.start();
    for (let i = 0; i < 12; i++) {
      await svc.tick();
      rig.clock.advance(60_000);
    }
    expect(alertKinds(rig)).toContain('precheck_stalled');
    expect(alertKinds(rig)).toContain('precheck_late');
    expect(svc.result(claimId)?.state).toBe('seen');
    expect(rig.node.broadcasts).toHaveLength(0);

    rig.world.faults.length = 0;
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('intent');
    svc.close();
  });

  it('a mirror failure on the topic page shows on health and the next tick recovers', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    rig.world.fail(/topics\/[^/]+\/messages\?sequencenumber/, 503, 1);
    const svc = await rig.start();
    await svc.tick();
    expect(svc.health()).toMatchObject({ ok: false });
    rig.clock.advance(15_000);
    await svc.tick();
    expect(svc.health()).toMatchObject({ ok: true });
    expect(svc.result(claimId)?.state).toBe('intent');
    svc.close();
  });

  it('a payer that cannot be found raises an alert and holds the claim', async () => {
    const rig = makeRig();
    const orderId = orderIdOf(3);
    const rec = rig.world.addRecord({ kind: 0, orderId, payer: null });
    rig.world.fail(/api\/v1\/transactions/, 404, 100);
    const claimId = rig.world.fileClaim(orderId, refsOf(500n, { 0: { seq: rec.seq, hash: rec.hash } }));
    rig.chain.claims.set(claimId, { status: 1, packHash: ZERO_HASH });
    const svc = await rig.start();
    await svc.tick();
    expect(alertKinds(rig)).toContain('mirror_lag');
    expect(svc.result(claimId)).toMatchObject({ state: 'seen', slots: [] });
    expect(journalRecords(rig).some((r) => r.t === 'claimResolved')).toBe(false);
    svc.close();
  });
});
