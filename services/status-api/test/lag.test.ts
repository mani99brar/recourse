import { describe, expect, it } from 'vitest';
import { Indexer } from '../src/indexer.js';
import { DocFetcher } from '../src/ipfs.js';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { CLAIMS, VAULT, buildClaim } from './helpers/fixtures.js';
import { FakeMirror } from './helpers/mirror.js';
import { harness, testConfig, testDeployments, testParties } from './helpers/service.js';

function rig() {
  const m = new FakeMirror();
  const sim = new Sim(1_700_000_000n);
  buildClaim(sim, 'finding_made', 1);
  m.addLogs(CLAIMS, sim.logs.filter((l) => l.contract === 'claims'));
  m.addLogs(VAULT, sim.logs.filter((l) => l.contract === 'vault'));
  const clock = { now: 1_700_000_100 };
  const setHead = () => (m.headTs = `${clock.now}.000000000`);
  setHead();
  const store = new Store();
  const cfg = testConfig({ recordsTopic: '', viewCacheMs: 0 });
  const deployments = testDeployments({ caseAddress: undefined });
  const docs = new DocFetcher({ fetch: m.fetch, gatewayUrl: null, ratePerMin: 10, timeoutMs: 100 });
  const indexer = new Indexer({ store, cfg, deployments, fetch: m.fetch, arbRpc: null, reader: null, parties: () => testParties(), docs, nowS: () => clock.now });
  const h = harness({ store, now: clock.now, reader: null, cfg: { recordsTopic: '' }, deployments: { caseAddress: undefined } });
  h.clock = clock as never;
  // Share one clock between the service and the indexer.
  (h.svc.d as { nowS: () => number }).nowS = () => clock.now;
  return { m, clock, setHead, indexer, h, store };
}

describe('lag on a quiet source', () => {
  it('stays out of degraded[] after 60 quiet minutes while every poll succeeds', async () => {
    const r = rig();
    await r.indexer.pollOnce();
    expect(r.h.svc.degraded()).toEqual([]);
    for (let i = 0; i < 12; i++) {
      r.clock.now += 300; // five minutes between polls, nothing new on the chain
      r.setHead();
      await r.indexer.pollOnce();
      expect(r.h.svc.degraded()).toEqual([]);
    }
    expect(r.h.svc.health().sources.hedera.lagS).toBe(0);
  });

  it('goes into degraded[] when the poll fails, and reports the error', async () => {
    const r = rig();
    await r.indexer.pollOnce();
    r.clock.now += 300;
    r.setHead();
    r.m.failNext = 100;
    await r.indexer.pollOnce();
    expect(r.h.svc.degraded()).toContain('hedera');
    const src = r.h.svc.health().sources.hedera;
    expect(src.lastError).toMatch(/503/);
    expect(src.lagS).toBeGreaterThan(60);
  });

  it('recovers once polls succeed again', async () => {
    const r = rig();
    await r.indexer.pollOnce();
    r.clock.now += 300;
    r.setHead();
    r.m.failNext = 100;
    await r.indexer.pollOnce();
    r.m.failNext = 0;
    r.clock.now += 120; // past the backoff
    r.setHead();
    await r.indexer.pollOnce();
    expect(r.h.svc.degraded()).toEqual([]);
  });
});
