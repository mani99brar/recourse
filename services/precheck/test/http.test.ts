import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, listen } from '../src/http.js';
import { ZERO_HASH } from '@recourse/shared';
import { addLaterMessage, cleanupRigs, KINDS, makeRig, orderIdOf, refsFor, setupClaim } from './support.js';

afterEach(cleanupRigs);

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(source: Parameters<typeof createApp>[0]) {
  const server = await listen(createApp(source), 0);
  servers.push(server);
  const { address, port } = server.address() as AddressInfo;
  return { address, base: `http://127.0.0.1:${port}` };
}

describe('http', () => {
  it('binds to loopback only', async () => {
    const rig = makeRig();
    const svc = await rig.start();
    const { address } = await serve(svc);
    expect(address).toBe('127.0.0.1');
    svc.close();
  });

  it('GET /health shows the cursors, lag, last error, queue and pause state', async () => {
    const rig = makeRig();
    setupClaim(rig, { later: true });
    const svc = await rig.start({ config: { pauseWindows: [{ chain: 'hedera', from: 0, to: 4_000_000_000 }] } });
    await svc.tick();
    const { base } = await serve(svc);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      ok: true,
      service: 'precheck',
      queue: 1,
      pause: { paused: true, windows: 1 },
      lastError: null,
      cursors: { topic: { topicId: '9.9.500', seq: '7' }, claimLogs: {} },
      lag: { mirrorS: 0 },
    });
    expect(typeof body.cursors.claimLogs.timestamp).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/key|password|secret/i);
    svc.close();
  });

  it('GET /results/:claimId gives state, packHash, cid, gap, answer and per-slot outcomes', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { later: true, omit: [4] });
    const svc = await rig.start();
    await svc.tick();
    const { base } = await serve(svc);
    const res = await fetch(`${base}/results/${claimId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({ claimId, state: 'intent', gap: '255', answer: '2', reasonKey: 'missing_record_shop' });
    expect(body.packHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.cid).toMatch(/^b[a-z2-7]+$/);
    expect(body.slots).toHaveLength(6);
    expect(body.slots[4]).toEqual({ kind: '4', outcome: 'absent' });
    expect(body.slots[0]).toEqual({ kind: '0', outcome: 'held' });
    svc.close();
  });

  it('a rejected slot shows its reason', async () => {
    const rig = makeRig();
    const orderId = orderIdOf(1);
    const added = KINDS.map((kind) => rig.world.addRecord({ kind, orderId, payer: kind === 4 ? '9.9.3001' : undefined }));
    addLaterMessage(rig.world);
    // The refs name a packed record from an account that is not the shop's.
    const claimId = rig.world.fileClaim(orderId, refsFor(added));
    rig.chain.claims.set(claimId, { status: 1, packHash: ZERO_HASH });
    const svc = await rig.start();
    await svc.tick();
    const { base } = await serve(svc);
    const body = (await (await fetch(`${base}/results/${claimId}`)).json()) as { slots: Record<string, string>[] };
    expect(body.slots[4]).toEqual({ kind: '4', outcome: 'rejected', reason: 'payer_mismatch' });
    svc.close();
  });

  it('is 404 for an unknown claim and 400 for something that is not a claim id', async () => {
    const rig = makeRig();
    const svc = await rig.start();
    const { base } = await serve(svc);
    expect((await fetch(`${base}/results/0x${'ab'.repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${base}/results/nonsense`)).status).toBe(400);
    svc.close();
  });

  it('a claim not yet resolved shows its state and no slots', async () => {
    const rig = makeRig();
    const { claimId } = setupClaim(rig, { omit: [4] }); // no later message: the topic is not read through the filing
    const svc = await rig.start();
    await svc.tick();
    const { base } = await serve(svc);
    const body = await (await fetch(`${base}/results/${claimId.toUpperCase().replace('0X', '0x')}`)).json();
    expect(body).toEqual({ claimId, state: 'seen', slots: [] });
    svc.close();
  });
});
