import { claimsAbi, replayJournal } from '@recourse/keeper';
import { recordHash, ZERO_HASH } from '@recourse/shared';
import { decodeFunctionData, parseTransaction, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { rawBlockCid, type DocStore } from '../src/docs.js';
import { alertKinds, cleanupRigs, FILED_AT, gatewayBackedDocs, journalRecords, makeRig, setupClaim, type Rig } from './support.js';

afterEach(cleanupRigs);

const FOREVER = [{ chain: 'hedera' as const, from: 0, to: 4_000_000_000 }];

/** Runs a service paused until the claim is built and pinned, and returns what it would send. */
async function preview(rig: Rig, claimId: Hex): Promise<{ packHash: Hex; cid: string }> {
  const svc = await rig.start({ config: { pauseWindows: FOREVER } });
  await svc.tick();
  const v = svc.result(claimId);
  svc.close();
  if (v?.packHash === undefined || v.cid === undefined) throw new Error('claim was not pinned');
  return { packHash: v.packHash, cid: v.cid };
}

async function sentCall(rig: Rig) {
  const raw = [...rig.node.mined.keys(), ...rig.node.mempool.keys()].map((h) => rig.node.mempool.get(h)?.raw).filter((r): r is Hex => r !== undefined);
  return raw.map((r) => decodeFunctionData({ abi: claimsAbi, data: parseTransaction(r).data ?? '0x' }));
}

describe('determinism', () => {
  it('two runs over the same claim and chain data give the same bytes, packHash and cid', async () => {
    const results: { packHash: Hex; cid: string; bytes: Uint8Array }[] = [];
    for (let i = 0; i < 2; i++) {
      const rig = makeRig();
      const { claimId } = setupClaim(rig, { later: true });
      const p = await preview(rig, claimId);
      const bytes = await rig.docs.fetch(p.cid);
      results.push({ ...p, bytes: bytes! });
    }
    expect(results[0]!.packHash).toBe(results[1]!.packHash);
    expect(results[0]!.cid).toBe(results[1]!.cid);
    expect(results[0]!.bytes).toEqual(results[1]!.bytes);
    expect(recordHash(results[0]!.bytes)).toBe(results[0]!.packHash);
  });

  it('restarting before the claim moves on rebuilds the same document from the journal', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const first = await preview(rig, claimId);
    const svc = await rig.start({ config: { pauseWindows: FOREVER } });
    expect(svc.result(claimId)).toMatchObject({ state: 'pinned', ...first });
    svc.close();
  });
});

describe('write once', () => {
  it('sends recordPreCheck with the document hash, and is done only when the mirror shows it', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const svc = await rig.start();
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('intent');
    expect(rig.node.broadcasts).toHaveLength(1);

    const [call] = await sentCall(rig);
    const v = svc.result(claimId)!;
    expect(call).toMatchObject({ functionName: 'recordPreCheck' });
    expect(call?.args).toEqual([claimId, Number(v.gap), Number(v.answer), v.packHash]);

    // A receipt alone is not done.
    rig.node.mine();
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('recorded');
    // Nothing more is sent, however many ticks pass.
    for (let i = 0; i < 3; i++) {
      rig.clock.advance(60_000);
      await svc.tick();
    }
    expect(rig.node.broadcasts).toHaveLength(1);
    svc.close();
  });

  it('a mined transaction without PreCheckRecorded on the mirror is not done', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const svc = await rig.start();
    await svc.tick();
    rig.node.mine();
    rig.world.logs = rig.world.logs.filter((l) => l.topics.length === 4); // keep ClaimFiled, drop PreCheckRecorded (2 topics)
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('intent');
    expect(rig.node.broadcasts).toHaveLength(1);
    svc.close();
  });

  it('crash after the pin, before it is journaled: the restart pins the same bytes and sends one transaction', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const base = gatewayBackedDocs(rig.world, rig.docs);
    let crashed = false;
    const crashing: DocStore = {
      fetch: base.fetch,
      async pin(bytes) {
        const cid = await base.pin(bytes);
        if (!crashed) {
          crashed = true;
          throw new Error('process died');
        }
        return cid;
      },
    };
    const one = await rig.start({ docs: crashing });
    await one.tick();
    expect(replayJournal(rig.dir).records.some((r) => r.t === 'claimPinned')).toBe(false);
    one.close();

    const two = await rig.start();
    await two.tick();
    expect(rig.node.broadcasts).toHaveLength(1);
    rig.node.mine();
    await two.tick();
    expect(two.result(claimId)?.state).toBe('recorded');
    expect(rig.node.broadcasts).toHaveLength(1);
    two.close();
  });

  it('crash after the intent is journaled, before broadcast: the restart rebroadcasts the same bytes, one transaction', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const one = await rig.start({
      senderOptions: {
        receiptWaitMs: 0,
        onIntent: () => {
          throw new Error('process died');
        },
      },
    });
    await one.tick();
    const intents = journalRecords(rig).filter((r) => r.t === 'intent');
    expect(intents).toHaveLength(1);
    expect(rig.node.broadcasts).toHaveLength(0);
    one.close();

    const two = await rig.start();
    expect(rig.node.broadcasts).toEqual([intents[0]!.raw]);
    await two.tick();
    expect(rig.node.broadcasts).toHaveLength(1);
    rig.node.mine();
    await two.tick();
    expect(two.result(claimId)?.state).toBe('recorded');
    expect(journalRecords(rig).filter((r) => r.t === 'intent')).toHaveLength(1);
    two.close();
  });

  it('a broadcast that is still pending after a restart is not sent again', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const one = await rig.start();
    await one.tick();
    one.close();
    const two = await rig.start();
    await two.tick();
    rig.clock.advance(60_000);
    await two.tick();
    expect(rig.node.broadcasts).toHaveLength(1);
    rig.node.mine();
    await two.tick();
    expect(two.result(claimId)?.state).toBe('recorded');
    two.close();
  });

  it('recorded claims load as done and are never looked at again', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const one = await rig.start();
    await one.tick();
    rig.node.mine();
    await one.tick();
    one.close();

    const reads = rig.chain.reads;
    const requests = rig.world.requests.filter((u) => u.includes('gateway.example')).length;
    const two = await rig.start();
    for (let i = 0; i < 3; i++) {
      rig.clock.advance(60_000);
      await two.tick();
    }
    expect(two.result(claimId)?.state).toBe('recorded');
    expect(rig.chain.reads).toBe(reads);
    expect(rig.world.requests.filter((u) => u.includes('gateway.example')).length).toBe(requests);
    expect(rig.node.broadcasts).toHaveLength(1);
    two.close();
  });

  it('a ClaimFiled read twice is one claim', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    rig.world.logs.push({ ...rig.world.logs[0]!, index: 99 });
    const svc = await rig.start();
    await svc.tick();
    expect(Object.keys(svc.claimStates())).toEqual([claimId]);
    expect(journalRecords(rig).filter((r) => r.t === 'claimSeen')).toHaveLength(1);
    svc.close();
  });
});

describe('what is already on chain', () => {
  it('equal packHash already recorded: done once the mirror shows it, and nothing is sent', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const { packHash } = await preview(rig, claimId);
    rig.chain.claims.set(claimId, { status: 2, packHash });

    // The chain says so but the mirror has not shown the event: not done yet.
    const svc = await rig.start();
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('pinned');
    expect(rig.node.broadcasts).toHaveLength(0);

    rig.world.preCheckRecorded(claimId, 3, 3, packHash, `${FILED_AT + 40n}.000000001`);
    rig.clock.advance(15_000);
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('recorded');
    expect(rig.node.broadcasts).toHaveLength(0);
    expect(alertKinds(rig)).not.toContain('precheck_conflict');
    svc.close();
  });

  it('a different packHash on chain: precheck_conflict, no send, the claim is stopped', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    await preview(rig, claimId);
    rig.chain.claims.set(claimId, { status: 2, packHash: `0x${'ab'.repeat(32)}` });
    const svc = await rig.start();
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('conflict');
    expect(alertKinds(rig)).toContain('precheck_conflict');
    expect(rig.node.broadcasts).toHaveLength(0);
    for (let i = 0; i < 2; i++) {
      rig.clock.advance(60_000);
      await svc.tick();
    }
    expect(rig.chain.reads).toBeLessThan(5);
    svc.close();

    const again = await rig.start();
    await again.tick();
    expect(again.result(claimId)?.state).toBe('conflict');
    again.close();
  });

  it('a different PreCheckRecorded on the mirror is a conflict too', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    rig.world.preCheckRecorded(claimId, 1, 1, `0x${'cd'.repeat(32)}`, `${FILED_AT + 10n}.000000001`);
    const svc = await rig.start();
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('conflict');
    expect(rig.node.broadcasts).toHaveLength(0);
    svc.close();
  });

  it('a claim that left Filed with no pre-check gets no send', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    rig.chain.claims.set(claimId, { status: 8, packHash: ZERO_HASH });
    const svc = await rig.start();
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('closed');
    expect(rig.node.broadcasts).toHaveLength(0);
    svc.close();
  });

  it('no send inside a pause window, and the send happens after it', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const until = Number(FILED_AT) + 600;
    const svc = await rig.start({ config: { pauseWindows: [{ chain: 'hedera', from: 0, to: until }] } });
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('pinned');
    expect(svc.health()).toMatchObject({ pause: { paused: true } });
    expect(rig.node.broadcasts).toHaveLength(0);
    rig.clock.setSeconds(until + 1);
    await svc.tick();
    expect(rig.node.broadcasts).toHaveLength(1);
    svc.close();
  });

  it('a simulation that reverts sends nothing and alerts', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    rig.node.revertCalls = true;
    const svc = await rig.start();
    await svc.tick();
    expect(rig.node.broadcasts).toHaveLength(0);
    expect(alertKinds(rig)).toContain('call_failed');
    expect(svc.result(claimId)?.state).toBe('pinned');
    svc.close();
  });

  it('refuses to send when the pinned document does not read back from its cid', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true });
    const base = gatewayBackedDocs(rig.world, rig.docs);
    // Pins return a cid but never publish the bytes, so the read-back finds nothing.
    const unpublished: DocStore = { fetch: base.fetch, pin: async (bytes) => rawBlockCid(bytes) };
    const svc = await rig.start({ docs: unpublished });
    await svc.tick();
    expect(svc.result(claimId)?.state).toBe('pinned');
    expect(rig.node.broadcasts).toHaveLength(0);
    svc.close();
  });
});
