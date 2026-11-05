import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { PLATFORM, TOPIC, buildClaim, h32, ingest } from './helpers/fixtures.js';
import { harness } from './helpers/service.js';

async function setup() {
  const sim = new Sim();
  const b = buildClaim(sim, 'at_court', 1);
  const store = new Store();
  ingest(store, sim);
  store.live.set(b.claimId, b.live!);
  const h = harness({ store, now: Number(b.now) });
  return { b, h, store, sim };
}

describe('search', () => {
  it('finds a claim, order, message, pack hash and transaction by exact value', async () => {
    const { b, h, sim } = await setup();
    const types = async (q: string) => (await h.svc.search(q)).hits.map((x) => x.type);
    expect(await types(b.claimId)).toContain('claim');
    expect(await types(b.orderId)).toContain('order');
    expect(await types(b.sendMsg)).toContain('message');
    expect(await types(h32(0x9a01))).toContain('packHash');
    const tx = sim.logs.find((l) => l.contract === 'claims')!.raw.tx;
    expect(await types(tx)).toContain('tx');
    const hit = (await h.svc.search(b.claimId)).hits[0]!;
    expect(hit.claimId).toBe(b.claimId);
  });

  it('finds a dispute id, an account, a topic and an address', async () => {
    const { b, h } = await setup();
    expect((await h.svc.search('901')).hits).toEqual([{ type: 'dispute', id: '901', claimId: b.claimId }]);
    expect((await h.svc.search('0.0.1001')).hits.map((x) => x.type)).toContain('party');
    expect((await h.svc.search(TOPIC)).hits).toEqual([{ type: 'topic', id: TOPIC, claimId: null }]);
    expect((await h.svc.search(PLATFORM.toLowerCase())).hits.map((x) => x.type)).toContain('party');
  });

  it('returns nothing for a near miss', async () => {
    const { b, h } = await setup();
    const near = (b.claimId.slice(0, -1) + (b.claimId.endsWith('0') ? '1' : '0')) as string;
    expect((await h.svc.search(near)).hits).toEqual([]);
    expect((await h.svc.search('902')).hits).toEqual([]);
    expect((await h.svc.search('0.0.1003')).hits).toEqual([]);
    expect((await h.svc.search('4000:99')).hits).toEqual([]);
    expect((await h.svc.search('some words')).hits).toEqual([]);
  });

  it('rejects an empty query', async () => {
    const { h } = await setup();
    await expect(h.svc.search('  ')).rejects.toMatchObject({ status: 400 });
  });
});
