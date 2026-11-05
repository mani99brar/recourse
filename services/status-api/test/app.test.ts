import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Sim } from './helpers/encode.js';
import { buildClaim, fakeReader, ingest } from './helpers/fixtures.js';
import { harness, serve } from './helpers/service.js';

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

async function boot(opts: { rebuilding?: boolean; origin?: string } = {}) {
  const sim = new Sim();
  const b = buildClaim(sim, 'settled', 1);
  const store = new Store();
  ingest(store, sim);
  store.rebuilding = opts.rebuilding ?? false;
  for (const s of ['hedera', 'arbitrum', 'hcs'] as const) store.status[s].indexedThrough = Number(b.now);
  const h = harness({ store, now: Number(b.now), reader: fakeReader(), ...(opts.origin ? { cfg: { webOrigin: opts.origin } } : {}) });
  const s = await serve(h.svc);
  closers.push(s.close);
  return { b, url: s.url, h };
}

describe('http api', () => {
  it('serves /claims/:id with bigint as decimal text and freshness fields on every response', async () => {
    const { b, url } = await boot();
    const res = await fetch(`${url}/claims/${b.claimId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.statusKey).toBe('settled');
    expect(body.basketUsdc).toBe('60000000');
    expect(body.asOf).toHaveProperty('hedera');
    expect(Array.isArray(body.degraded)).toBe(true);
    expect(body.events.map((e: { name: string }) => e.name)).toContain('Settled');
    expect(body.money.escrow.fate).toBe('kept_by_pool');
  });

  it('lists claims with a status filter and with a party', async () => {
    const { b, url, h } = await boot();
    const all = (await (await fetch(`${url}/claims`)).json()) as any;
    expect(all.rows).toHaveLength(1);
    const none = (await (await fetch(`${url}/claims?status=filed`)).json()) as any;
    expect(none.rows).toHaveLength(0);
    const party = (await (await fetch(`${url}/claims?party=${all.rows[0].shop}`)).json()) as any;
    expect(Object.keys(party)).toEqual(expect.arrayContaining(['standing', 'groups', 'rows']));
    void b; void h;
  });

  it('answers 400 bad_id, 404 unknown and 405 for writes', async () => {
    const { url } = await boot();
    expect(await (await fetch(`${url}/claims/0x12`)).json()).toMatchObject({ error: 'bad_id' });
    const missing = await fetch(`${url}/claims/0x${'ab'.repeat(32)}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'unknown' });
    expect((await fetch(`${url}/claims`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${url}/nothing`)).status).toBe(404);
  });

  it('answers 503 rebuilding while it catches up, but /health still answers', async () => {
    const { url } = await boot({ rebuilding: true });
    const r = await fetch(`${url}/claims`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'rebuilding', rebuilding: true });
    const h = (await (await fetch(`${url}/health`)).json()) as any;
    expect(h.rebuilding).toBe(true);
  });

  it('sets CORS only for the configured web origin', async () => {
    const withOrigin = await boot({ origin: 'https://recourse.example' });
    const r = await fetch(`${withOrigin.url}/health`);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://recourse.example');
    const without = await boot();
    expect((await fetch(`${without.url}/health`)).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves /params with live values, locks and the disclosed powers', async () => {
    const { url } = await boot();
    const p = (await (await fetch(`${url}/params`)).json()) as any;
    expect(p.params.claims.contestWindow).toBe('600');
    expect(p.lock).toEqual({ claims: false, vault: false, case: false });
    expect(p.disclosedPowers.map((x: { name: string }) => x.name)).toContain('setRequired');
    expect(p.addresses.offRampArbitrum.toLowerCase()).toContain('c93218eb');
    expect(p.schemeWallet).toMatch(/^0x/);
  });

  it('serves /parties/:address and /search', async () => {
    const { url, b } = await boot();
    const party = (await (await fetch(`${url}/parties/${'0x' + '22'.repeat(20)}`)).json()) as any;
    expect(party.role).toBe('shop');
    const s = (await (await fetch(`${url}/search?q=${b.claimId}`)).json()) as any;
    expect(s.hits[0].type).toBe('claim');
  });

  it('reports unreachable docket and precheck without failing the page', async () => {
    const { url, b } = await boot();
    const d = (await (await fetch(`${url}/claims/${b.claimId}`)).json()) as any;
    expect(d.docket.writeStatus).toBe('unreachable');
    expect(d.precheck.result).toBeNull();
  });
});
