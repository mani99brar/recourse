// A relay that hangs or fails: every read answers within the read wait from the last good values,
// says which reads are behind and how old their values are, and an action's chain read that does
// not answer fails as upstream_unavailable naming the RPC, well before the action's deadline.

import { getAddress } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ActionReads } from '../src/chain.js';
import { refreshLive, type Reader } from '../src/live.js';
import { Store } from '../src/store.js';
import { fakeChain } from './helpers/chain.js';
import { Sim } from './helpers/encode.js';
import { PLATFORM, SHOP, buildClaim, fakeReader, ingest } from './helpers/fixtures.js';
import { check, responseSchema } from './helpers/schema.js';
import { harness } from './helpers/service.js';

const WAIT_MS = 150;
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

const hang = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A reader whose calls answer as the fake does while `mode` is ok, never while it hangs, and with an error while it fails. */
function switchable() {
  const base = fakeReader();
  const mode = { now: 'ok' as 'ok' | 'hang' | 'fail' };
  const reads = { party: 0, params: 0 };
  const gate = <T>(f: () => Promise<T>): Promise<T> => (mode.now === 'hang' ? hang<T>() : mode.now === 'fail' ? Promise.reject(new Error('502 from the relay')) : f());
  const reader: Reader = {
    ...base,
    claimsParams: () => (reads.params++, gate(() => base.claimsParams())),
    caseParams: () => gate(() => base.caseParams()),
    vaultParams: () => gate(() => base.vaultParams()),
    facts: () => gate(() => base.facts()),
    locks: () => gate(() => base.locks()),
    party: (a) => (reads.party++, gate(() => base.party(a))),
  };
  return { reader, mode, reads };
}

async function boot(reader: Reader, chain: ActionReads | null = null) {
  const sim = new Sim();
  const built = [buildClaim(sim, 'finding_made', 1), buildClaim(sim, 'settled', 2)];
  const store = new Store();
  ingest(store, sim);
  const now = built.reduce((m, b) => (b.now > m ? b.now : m), 0n);
  for (const s of ['hedera', 'arbitrum', 'hcs'] as const) store.status[s].indexedThrough = Number(now);
  const h = harness({ store, now: Number(now), reader, deployments: { arbitrumChainId: 421_614 }, cfg: { readWaitMs: WAIT_MS, actionReadWaitMs: WAIT_MS, actionDeadlineMs: 10_000 } });
  const app = createApp(h.svc, { chain, creditWaitMs: WAIT_MS });
  const url = await new Promise<string>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      closers.push(() => server.close());
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
  const timed = async (path: string, init?: RequestInit) => {
    const t = Date.now();
    const r = await fetch(`${url}${path}`, init);
    return { status: r.status, body: (await r.json()) as any, ms: Date.now() - t };
  };
  return { h, built, timed };
}

const READS = ['/v1/params', `/v1/claims?party=${SHOP}`, `/v1/parties/${SHOP}`, `/v1/parties/${PLATFORM}`, '/v1/claims'];

describe('reads on a relay that hangs or fails', () => {
  it('answer from the defaults within the wait when nothing was ever read, and say so', async () => {
    const { reader, mode } = switchable();
    mode.now = 'hang';
    const { timed } = await boot(reader);
    for (const path of READS) {
      const r = await timed(path);
      expect(r.status, path).toBe(200);
      expect(r.ms, path).toBeLessThan(WAIT_MS + 400);
      expect(r.body.meta.degraded, path).toContain('params');
      expect(check(responseSchema(path.replace(/\?.*$/, '').replace(SHOP, '{address}').replace(PLATFORM, '{address}'), 'get'), r.body), path).toEqual([]);
    }
    const p = await timed('/v1/params');
    expect(p.body.params.params.defaulted).toBe(true);
    expect(p.body.meta.degraded).toEqual(expect.arrayContaining(['params', 'facts']));
    expect(p.body.meta.stale).toContainEqual({ read: 'params', upstreams: ['hedera_rpc', 'arbitrum_rpc'], readAt: null, ageS: null });
    const party = await timed(`/v1/parties/${SHOP}`);
    expect(party.body.party.credit).toBeNull();
    expect(party.body.meta.degraded).toContain('vault');
  });

  it('serve the last good values with their age once the relay hangs, and read each one only once at a time', async () => {
    const { reader, mode, reads } = switchable();
    const { h, timed } = await boot(reader);
    for (const path of READS) await timed(path);
    const fresh = await timed(`/v1/parties/${SHOP}`);
    expect(fresh.body.party.balance).toBe('100000000');
    expect(fresh.body.meta.degraded).toEqual([]);
    expect(fresh.body.meta.stale).toEqual([]);
    const readAt = h.clock.now;

    mode.now = 'hang';
    h.clock.now += 90;
    const before = { ...reads };
    for (const path of READS) {
      const r = await timed(path);
      expect(r.status, path).toBe(200);
      expect(r.ms, path).toBeLessThan(WAIT_MS + 400);
    }
    const party = await timed(`/v1/parties/${SHOP}`);
    expect(party.body.party.balance).toBe('100000000');
    expect(party.body.meta.degraded).toEqual(expect.arrayContaining(['params', 'vault']));
    expect(party.body.meta.stale).toContainEqual({ read: 'vault', upstreams: ['hedera_rpc'], readAt, ageS: 90 });
    expect(party.body.meta.stale).toContainEqual({ read: 'params', upstreams: ['hedera_rpc', 'arbitrum_rpc'], readAt, ageS: 90 });
    expect(party.body.meta.stale).toContainEqual({ read: 'facts', upstreams: ['hedera_rpc', 'arbitrum_rpc'], readAt, ageS: 90 });
    const params = await timed('/v1/params');
    expect(params.body.params.params.defaulted).toBe(false);
    expect(params.body.params.params.claims.contestWindow).toBe('600');
    // The hanging reads were started once each, not again on every request.
    expect(reads.params - before.params).toBe(1);
    expect(reads.party - before.party).toBeLessThanOrEqual(2);
  });

  it('serve the last good values on a failing relay, and stop saying so once a read lands', async () => {
    const { reader, mode } = switchable();
    const { h, timed } = await boot(reader);
    await timed('/v1/params');
    mode.now = 'fail';
    h.clock.now += 30;
    const failed = await timed('/v1/params');
    expect(failed.body.params.params.defaulted).toBe(false);
    expect(failed.body.meta.degraded).toEqual(expect.arrayContaining(['params', 'facts']));
    expect(failed.body.meta.stale.find((s: any) => s.read === 'params').ageS).toBe(30);
    expect(failed.body.params.preCheckSigner).toBe(SHOP);
    mode.now = 'ok';
    const back = await timed('/v1/params');
    expect(back.body.meta.degraded).toEqual([]);
    expect(back.body.meta.stale).toEqual([]);
  });

  it('warm reads the parameters, the facts and the vault views of known parties in the background', async () => {
    const { reader, reads } = switchable();
    const { h } = await boot(reader);
    await h.svc.warm();
    expect(reads.params).toBe(1);
    expect(reads.party).toBeGreaterThanOrEqual(2);
    expect(h.svc.knownCredit(SHOP)).toBe(0n);
    expect(h.svc.degraded()).toEqual([]);
  });

  it('warm reads again a party whose vault read failed, also one it does not read otherwise', async () => {
    const { reader, mode } = switchable();
    const { h } = await boot(reader);
    const agent = getAddress('0x' + '31'.repeat(20));
    mode.now = 'fail';
    await h.svc.party(agent); // the agent's page during a relay blip
    expect(h.svc.degraded()).toContain('vault');
    mode.now = 'ok';
    h.clock.now += 30;
    await h.svc.warm();
    expect(h.svc.degraded()).not.toContain('vault');
    expect(h.svc.stale().filter((s) => s.read === 'vault')).toEqual([]);
  });

  it('the legacy routes are bounded the same way', async () => {
    const { reader, mode } = switchable();
    mode.now = 'hang';
    const { timed } = await boot(reader);
    for (const path of ['/params', `/claims?party=${SHOP}`, `/parties/${SHOP}`]) {
      const r = await timed(path);
      expect(r.status, path).toBe(200);
      expect(r.ms, path).toBeLessThan(WAIT_MS + 400);
      expect(r.body.degraded, path).toContain('params');
    }
  });
});

describe('the live refresh on a relay that hangs', () => {
  it('stops reading a chain once one of its reads is late, and reports live on that chain', async () => {
    const sim = new Sim();
    const built = [buildClaim(sim, 'at_court', 1), buildClaim(sim, 'at_court', 2), buildClaim(sim, 'at_court', 3)];
    const store = new Store();
    ingest(store, sim);
    let caseReads = 0;
    const reader = fakeReader({ caseOf: () => (caseReads++, hang()), executionState: async () => 2 });
    const t = Date.now();
    await refreshLive(store, reader, () => 1_700_000_500, 50);
    expect(Date.now() - t).toBeLessThan(400);
    expect(caseReads).toBe(1);
    expect(store.liveReads.arbitrum).toEqual({ failing: true, okAt: null });
    expect(store.status.arbitrum.lastError).toMatch(/did not answer in time/);
    const h = harness({ store, now: 1_700_000_500 });
    expect(h.svc.degraded()).toContain('live');
    expect(h.svc.stale()).toContainEqual({ read: 'live', upstreams: ['arbitrum_rpc'], readAt: null, ageS: null });
    // The case reads answer again: live is current once a refresh reads Arbitrum without a failure.
    await refreshLive(store, fakeReader({ caseOf: async () => built[0]!.live!.caseView!, executionState: async () => 2 }), () => 1_700_000_600, 50);
    expect(store.liveReads.arbitrum).toEqual({ failing: false, okAt: 1_700_000_600 });
    expect(h.svc.degraded()).not.toContain('live');
  });

  it('stops reporting a chain once no claim needs it read, also after a failure there', async () => {
    const sim = new Sim();
    const b = buildClaim(sim, 'ruled', 1);
    const store = new Store();
    ingest(store, sim);
    // The case was read before; the message to court is not read as delivered yet.
    store.live.set(b.claimId, { ...b.live!, exec: { [b.sendMsg]: 0 } });
    let caseFails = true;
    const reader = fakeReader({
      caseOf: async () => {
        if (caseFails) throw new Error('arbitrum relay 502');
        return b.live!.caseView!;
      },
      executionState: async () => 2,
    });
    await refreshLive(store, reader, () => 1_700_000_500, 50);
    expect(store.liveReads.arbitrum.failing).toBe(true);
    // Every message now reads as delivered: the finished claim is not read again, and nothing else is.
    caseFails = false;
    await refreshLive(store, reader, () => 1_700_000_600, 50);
    expect(store.liveReads.arbitrum.failing).toBe(false);
    const h = harness({ store, now: 1_700_000_600, reader });
    expect(h.svc.degraded()).not.toContain('live');
    expect(h.svc.stale().filter((s) => s.read === 'live')).toEqual([]);
  });
});

describe('actions on a relay that hangs', () => {
  it('answer upstream_unavailable naming the RPC once a read has waited readWaitMs, not at the deadline', async () => {
    const { reader } = switchable();
    const sim = new Sim();
    const now = buildClaim(sim, 'finding_made', 1).now;
    const chain = fakeChain({ now });
    const { built, timed } = await boot(reader, chain);
    chain.claim = () => hang();
    const post = (name: string, body: unknown) => timed(`/v1/actions/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await post('contest', { from: PLATFORM, claimId: built[0]!.claimId });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('upstream_unavailable');
    expect(r.body.error.details.upstream).toBe('hedera_rpc');
    expect(r.ms).toBeLessThan(WAIT_MS + 400);
    chain.caseNow = () => hang();
    const a = await post('openCase', { from: PLATFORM, claimId: built[0]!.claimId });
    expect(a.status).toBe(503);
    expect(a.body.error.details.upstream).toBe('arbitrum_rpc');
    expect(a.ms).toBeLessThan(WAIT_MS * 2 + 400);
  });
});
