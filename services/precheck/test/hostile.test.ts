// Claims and records shaped by a party that wants the pre-check to stall or to pay the wrong side.

import { afterEach, describe, expect, it } from 'vitest';
import { APPROVAL_DOMAIN, APPROVAL_TYPES, REPORT_TYPES, ZERO_HASH } from '@recourse/shared';
import { getAddress } from 'viem';
import * as agentSigning from '../../agent/src/approval.js';
import { alertKinds, cleanupRigs, FILED_AT, journalRecords, makeRig, orderIdOf, PARTIES, refsOf, setupClaim } from './support.js';

afterEach(cleanupRigs);

async function tickFor(svc: { tick(): Promise<void> }, rig: ReturnType<typeof makeRig>, minutes: number): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    await svc.tick();
    rig.clock.advance(60_000);
  }
}

describe('a writer that points a record at a document nobody can read', () => {
  it('cannot stall the claim: within the hour the slot is rejected and the finding goes against that writer', async () => {
    const rig = makeRig();
    // The platform's shown record is a message whose document was never pinned.
    const { claimId, added } = setupClaim(rig, { later: true });
    rig.world.gatewayDocs.delete(added[1]!.cid);
    const svc = await rig.start();
    await tickFor(svc, rig, 30);
    expect(svc.result(claimId)?.state).toBe('seen');
    expect(rig.node.broadcasts).toHaveLength(0);
    await tickFor(svc, rig, 45);
    const view = svc.result(claimId);
    expect(view).toMatchObject({ state: 'intent', answer: '1', reasonKey: 'missing_record_platform' });
    expect(view?.slots[1]).toEqual({ kind: '1', outcome: 'rejected', reason: 'doc_unavailable' });
    expect(rig.node.broadcasts).toHaveLength(1);
    svc.close();
  });

  it('a claim that left Filed on chain while its records could not be proved is closed, not retried for ever', async () => {
    const rig = makeRig();
    const orderId = orderIdOf(4);
    // The refs name a sequence number the mirror never has: the proof cannot settle.
    const claimId = rig.world.fileClaim(orderId, refsOf(500n, { 3: { seq: 9999, hash: `0x${'aa'.repeat(32)}` } }));
    rig.chain.claims.set(claimId, { status: 1, packHash: ZERO_HASH });
    const svc = await rig.start();
    await tickFor(svc, rig, 3);
    expect(svc.result(claimId)?.state).toBe('seen');
    rig.chain.claims.set(claimId, { status: 8, packHash: ZERO_HASH }); // expired
    await tickFor(svc, rig, 15);
    expect(svc.result(claimId)?.state).toBe('closed');
    expect(journalRecords(rig).some((r) => r.t === 'claimClosed' && r.status === 8)).toBe(true);
    expect(rig.node.broadcasts).toHaveLength(0);
    svc.close();
  });
});

describe('claims outside the party map', () => {
  for (const [who, by] of [
    ['a shop that is not a party', { shop: getAddress('0x00000000000000000000000000000000000000d1') }],
    ['a platform that is not a party', { platform: getAddress('0x00000000000000000000000000000000000000d2') }],
    ['a shop address that is the platform itself', { shop: PARTIES[0]!.evmAddress }],
  ] as const) {
    it(`get no pre-check at all: ${who}`, async () => {
      const rig = makeRig();
      const orderId = orderIdOf(9);
      // Records the platform wrote that would find against it (asked and ordered differ, no shown).
      const asked = rig.world.addRecord({ kind: 0, orderId });
      rig.world.addMessage({ bytes: new TextEncoder().encode('{}'), ts: `${FILED_AT + 5n}.000000000` });
      const claimId = rig.world.fileClaim(orderId, refsOf(500n, { 0: { seq: asked.seq, hash: asked.hash } }), FILED_AT, by);
      rig.chain.claims.set(claimId, { status: 1, packHash: ZERO_HASH });
      const svc = await rig.start();
      await tickFor(svc, rig, 3);
      expect(svc.result(claimId)).toMatchObject({ state: 'skipped', slots: [] });
      expect(rig.node.broadcasts).toHaveLength(0);
      expect(journalRecords(rig).filter((r) => r.t === 'claimSkipped')).toMatchObject([{ claimId, reason: 'unknown_party' }]);
      expect(alertKinds(rig)).toContain('claim_held');
      svc.close();
      // A restart keeps it skipped.
      const again = await rig.start();
      await again.tick();
      expect(again.result(claimId)?.state).toBe('skipped');
      expect(rig.node.broadcasts).toHaveLength(0);
      again.close();
    });
  }
});

describe('signing types', () => {
  it('are the ones the agent signs with', () => {
    expect(APPROVAL_DOMAIN).toEqual(agentSigning.APPROVAL_DOMAIN);
    expect(APPROVAL_TYPES).toEqual(agentSigning.APPROVAL_TYPES);
    expect(REPORT_TYPES).toEqual(agentSigning.REPORT_TYPES);
  });
});
