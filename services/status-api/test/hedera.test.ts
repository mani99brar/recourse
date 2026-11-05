import { describe, expect, it } from 'vitest';
import { pollHedera, type MirrorDeps } from '../src/sources/hedera.js';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { CLAIMS, PLATFORM, SHOP, VAULT, buildClaim, ingest } from './helpers/fixtures.js';
import { FakeMirror } from './helpers/mirror.js';

function deps(m: FakeMirror): MirrorDeps {
  return { fetch: m.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => 1_700_001_000 };
}

function load(m: FakeMirror, sim: Sim) {
  m.addLogs(CLAIMS, sim.logs.filter((l) => l.contract === 'claims'));
  m.addLogs(VAULT, sim.logs.filter((l) => l.contract === 'vault'));
}

describe('hedera log paging', () => {
  it('reads every log across page boundaries with no gaps or repeats', async () => {
    const sim = new Sim();
    buildClaim(sim, 'closed_uncontested', 1);
    buildClaim(sim.tick(5), 'finding_made', 2);
    const m = new FakeMirror();
    load(m, sim);
    const store = new Store();
    await pollHedera(store, deps(m), { claims: CLAIMS, vault: VAULT });
    const expected = sim.logs.filter((l) => l.chain === 'hedera').length;
    expect(store.events.size).toBe(expected);
    expect(store.status.hedera.failing).toBe(false);
    // A second poll with nothing new adds nothing.
    await pollHedera(store, deps(m), { claims: CLAIMS, vault: VAULT });
    expect(store.events.size).toBe(expected);
  });

  it('keeps logs that share a timestamp across a page boundary and picks up late ones', async () => {
    const sim = new Sim();
    // Three logs in one timestamp second; page size 2 splits them.
    sim.hedera('vault', 'RequiredSet', { platform: PLATFORM, amount: 1n });
    const t = sim.t;
    sim.hedera('vault', 'RequiredSet', { platform: SHOP, amount: 2n });
    sim.hedera('vault', 'RequiredSet', { platform: PLATFORM, amount: 3n });
    // Force the same consensus second for all three, differing only in nanos and index.
    for (const l of sim.logs) l.ts = `${t}.${String(l.raw.logIndex).padStart(9, '0')}`;
    const m = new FakeMirror();
    load(m, sim);
    const store = new Store();
    await pollHedera(store, deps(m), { vault: VAULT });
    expect(store.events.size).toBe(3);

    // A fourth log arrives later in the same second.
    sim.hedera('vault', 'RequiredSet', { platform: SHOP, amount: 4n });
    const late = sim.logs[3]!;
    late.ts = `${t}.${String(late.raw.logIndex).padStart(9, '0')}`;
    m.addLogs(VAULT, [late]);
    await pollHedera(store, deps(m), { vault: VAULT });
    expect(store.events.size).toBe(4);
    expect(new Set([...store.events.values()].map((e) => e.args.amount))).toEqual(new Set([1n, 2n, 3n, 4n]));
  });

  it('resumes from the cursor and asks only from the cursor timestamp', async () => {
    const sim = new Sim();
    buildClaim(sim, 'filed', 1);
    const m = new FakeMirror();
    load(m, sim);
    const store = new Store();
    await pollHedera(store, deps(m), { claims: CLAIMS, vault: VAULT });
    m.requests.length = 0;
    await pollHedera(store, deps(m), { claims: CLAIMS, vault: VAULT });
    const first = m.requests.find((r) => r.includes('/results/logs'))!;
    expect(first).toMatch(/timestamp=gte:\d+\.\d+/);
    expect(first).not.toContain('gte:0.000000000');
  });

  it('records a failure and keeps the state', async () => {
    const sim = new Sim();
    buildClaim(sim, 'filed', 1);
    const m = new FakeMirror();
    load(m, sim);
    const store = new Store();
    await pollHedera(store, deps(m), { claims: CLAIMS, vault: VAULT });
    const before = store.events.size;
    m.failNext = 5;
    await pollHedera(store, deps(m), { claims: CLAIMS, vault: VAULT });
    expect(store.status.hedera.failing).toBe(true);
    expect(store.status.hedera.lastError).toMatch(/503/);
    expect(store.events.size).toBe(before);
  });

  it('counts a log it cannot decode and skips it', async () => {
    const sim = new Sim();
    sim.hedera('vault', 'RequiredSet', { platform: PLATFORM, amount: 1n });
    sim.logs[0]!.raw.topics = ['0x' + 'ab'.repeat(32)] as never;
    const m = new FakeMirror();
    load(m, sim);
    const store = new Store();
    await pollHedera(store, deps(m), { vault: VAULT });
    expect(store.events.size).toBe(0);
    expect(store.status.hedera.decodeFailures).toBe(1);
    void ingest;
  });
});
