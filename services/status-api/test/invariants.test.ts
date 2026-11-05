import { describe, expect, it } from 'vitest';
import { plain } from '../src/json.js';
import { Store } from '../src/store.js';
import { pollHedera } from '../src/sources/hedera.js';
import { Sim } from './helpers/encode.js';
import { CLAIMS, SHOP2, STAGES, VAULT, buildClaim, ingest } from './helpers/fixtures.js';
import { FakeMirror } from './helpers/mirror.js';
import { harness } from './helpers/service.js';

function world() {
  const sim = new Sim();
  const built = STAGES.map((s, i) => {
    const b = buildClaim(sim, s, i + 1, { shop: i % 2 ? SHOP2 : undefined });
    sim.tick(100);
    return b;
  });
  return { sim, built };
}

async function snapshotOf(store: Store, built: ReturnType<typeof world>['built']) {
  for (const b of built) if (b.live) store.live.set(b.claimId, b.live);
  const h = harness({ store, now: 1_700_100_000 });
  const rows = plain(await h.svc.claimRows());
  const details = [];
  for (const b of built) details.push(plain(await h.svc.claimDetail(b.claimId)));
  return { rows, details };
}

describe('rebuild equals incremental', () => {
  it('replaying every log twice gives the same state as once', async () => {
    const { sim, built } = world();
    const once = new Store();
    ingest(once, sim);
    const twice = new Store();
    ingest(twice, sim);
    ingest(twice, sim);
    expect(await snapshotOf(twice, built)).toEqual(await snapshotOf(once, built));
  });

  it('feeding logs in shuffled chunks gives the same state as one pass', async () => {
    const { sim, built } = world();
    const once = new Store();
    ingest(once, sim);
    const chunked = new Store();
    const logs = [...sim.logs].reverse();
    for (let i = 0; i < logs.length; i += 7) {
      const part = new Sim();
      part.logs = logs.slice(i, i + 7);
      ingest(chunked, part);
    }
    expect(await snapshotOf(chunked, built)).toEqual(await snapshotOf(once, built));
  });

  it('a full read of the mirror equals an incremental read in small steps', async () => {
    const { sim, built } = world();
    const m = new FakeMirror();
    m.pageSize = 3;
    m.addLogs(CLAIMS, sim.logs.filter((l) => l.contract === 'claims'));
    m.addLogs(VAULT, sim.logs.filter((l) => l.contract === 'vault'));
    const deps = { fetch: m.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_001_000 };
    const full = new Store();
    await pollHedera(full, deps, { claims: CLAIMS, vault: VAULT });

    // Incremental: the mirror only knows a growing prefix at each poll.
    const inc = new Store();
    const all = { claims: m.logs.get(CLAIMS.toLowerCase())!, vault: m.logs.get(VAULT.toLowerCase())! };
    for (const cut of [5, 12, 20, 1000]) {
      m.logs.set(CLAIMS.toLowerCase(), all.claims.filter((l) => l.raw.logIndex < cut));
      m.logs.set(VAULT.toLowerCase(), all.vault.filter((l) => l.raw.logIndex < cut));
      await pollHedera(inc, deps, { claims: CLAIMS, vault: VAULT });
    }
    // The Arbitrum events come in directly for both.
    const arbOnly = new Sim();
    arbOnly.logs = sim.logs.filter((l) => l.chain === 'arbitrum');
    ingest(full, arbOnly);
    ingest(inc, arbOnly);
    expect(inc.events.size).toBe(full.events.size);
    expect(await snapshotOf(inc, built)).toEqual(await snapshotOf(full, built));
  });

  it('a store restored from its snapshot answers the same as the store that wrote it', async () => {
    const { sim, built } = world();
    const a = new Store();
    ingest(a, sim);
    for (const b of built) if (b.live) a.live.set(b.claimId, b.live);
    const restored = Store.fromJSON(a.toJSON());
    expect(restored).not.toBeNull();
    expect(await snapshotOf(restored!, built)).toEqual(await snapshotOf(a, built));
  });

  it('a corrupt snapshot is refused so the caller rebuilds', () => {
    expect(Store.fromJSON('{not json')).toBeNull();
    expect(Store.fromJSON('{"v":2}')).toBeNull();
  });
});
