import { afterEach, describe, expect, it } from 'vitest';
import { addressBook, parseParties, type Parties } from '@recourse/shared';
import { getAddress, type Address, type Hex } from 'viem';
import { createApp } from '../src/app.js';
import type { FetchLike } from '../src/http.js';
import { Store } from '../src/store.js';
import { registrationOf, type IdentityReads } from '../src/v1/cast.js';
import { Sim } from './helpers/encode.js';
import { PLATFORM, SHOP, SHOP2, TOPIC, buildClaim, h32, ingest } from './helpers/fixtures.js';
import { check, responseSchema } from './helpers/schema.js';
import { harness } from './helpers/service.js';

const PLATFORM2 = getAddress('0x' + '12'.repeat(20));
const REGISTRY = addressBook.hedera.erc8004Identity;

function castParties(): Parties {
  const r = parseParties([
    { role: 'platform', evmAddress: PLATFORM, hederaAccountId: '0.0.1001', hcsWriters: ['0.0.1002'], agentId: '149', displayName: 'Example Agent Co (sample)' },
    { role: 'agent', evmAddress: '0x' + '31'.repeat(20), hederaAccountId: '0.0.1002', hcsWriters: [], displayName: 'Example agent (sample)' },
    { role: 'shop', evmAddress: SHOP, hederaAccountId: '0.0.2001', hcsWriters: ['0.0.2001'], agentId: '150', displayName: 'Example Shop (sample)' },
    { role: 'platform', evmAddress: PLATFORM2, hederaAccountId: '0.0.1101', hcsWriters: ['0.0.1102'], agentId: '151', displayName: 'Example Buying Desk (sample)' },
    { role: 'shop', evmAddress: SHOP2, hederaAccountId: '0.0.2002', hcsWriters: ['0.0.2002'], agentId: '152', displayName: 'Example Pantry (sample)' },
    { role: 'scheme', evmAddress: '0x' + '41'.repeat(20), hederaAccountId: '0.0.3001', hcsWriters: [], displayName: 'Docket writer (sample)' },
  ]);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const dataUri = (doc: unknown) => `data:application/json;base64,${Buffer.from(JSON.stringify(doc), 'utf8').toString('base64')}`;
const recourse = (role: string, kind: string, label: string) => ({ role, kind, label, summary: `A ${label.toLowerCase()} in the demo (sample).` });

const SHOP_DOC_URL = 'https://shop.example/.well-known/agent-registration.json';
const DOCS: Record<string, unknown> = {
  [SHOP_DOC_URL]: { name: 'Example Shop (sample)', description: 'Sells shirts in sizes (sample).', services: [], recourse: recourse('shop', 'apparel-sizes', 'Physical goods with sizes') },
};

/** The registry as tests want it: per agent id an owner and a URI, or an error to throw. */
function fakeIdentity(agents: Record<string, { owner: Address; uri: string } | Error>, opts: { delayMs?: number } = {}) {
  const calls: string[] = [];
  const answer = async <T>(id: bigint, pick: (a: { owner: Address; uri: string }) => T): Promise<T> => {
    calls.push(String(id));
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const a = agents[String(id)];
    if (a === undefined || a instanceof Error) throw a ?? relayDown();
    return pick(a);
  };
  const reads: IdentityReads = { ownerOf: (id) => answer(id, (a) => a.owner), tokenURI: (id) => answer(id, (a) => a.uri) };
  return { reads, calls, agents };
}

const relayDown = () => Object.assign(new Error('HTTP request failed. Status: 502'), { name: 'HttpRequestError' });
const reverted = () => Object.assign(new Error('The contract function "ownerOf" reverted.'), { name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionRevertedError' } });

function fullCast() {
  return {
    '149': { owner: PLATFORM, uri: dataUri({ name: 'Example Agent Co (sample)', description: 'Shops for people (sample).', recourse: recourse('platform', 'personal-shopper', 'Personal shopping agent') }) },
    '150': { owner: SHOP, uri: SHOP_DOC_URL },
    // registered before the recourse object existed: shown with its role and an unknown type
    '151': { owner: PLATFORM2, uri: dataUri({ name: 'Example Buying Desk (sample)', description: 'Buys for a team (sample).' }) },
    '152': { owner: PLATFORM, uri: dataUri({ name: 'Example Pantry (sample)', description: 'Sells food (sample).', recourse: recourse('shop', 'perishable-goods', 'Perishable goods') }) },
  };
}

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

async function boot(identity: IdentityReads | null, opts: { waitMs?: number; rebuilding?: boolean } = {}) {
  const sim = new Sim();
  const built = [buildClaim(sim, 'closed_uncontested', 1), buildClaim(sim, 'finding_made', 2, { shop: SHOP2 })];
  const store = new Store();
  ingest(store, sim);
  store.rebuilding = opts.rebuilding ?? false;
  const now = built.reduce((m, b) => (b.now > m ? b.now : m), 0n);
  for (const s of ['hedera', 'arbitrum', 'hcs'] as const) store.status[s].indexedThrough = Number(now);
  // Records of three orders: two by the agent company's writer, one of them packed by the shop too, and one foreign payer.
  const rec = (seq: number, payer: string, kind: number, orderId: Hex) => ({ topic: TOPIC, seq, consensusTimestamp: `${seq}.0`, payer, kind, orderId, hash: h32(seq), cid: `bafysample${seq}` });
  store.addHcs([
    rec(1, '0.0.1002', 0, built[0]!.orderId),
    rec(2, '0.0.1002', 3, built[0]!.orderId),
    rec(3, '0.0.2001', 4, built[0]!.orderId),
    rec(4, '0.0.1002', 0, h32(0x0d01)),
    rec(5, '0.0.9999', 0, h32(0x0d02)),
  ]);
  const fetchDocs: FetchLike & { urls: string[] } = Object.assign(
    async (url: string) => {
      fetchDocs.urls.push(url);
      const doc = DOCS[url];
      const bytes = new TextEncoder().encode(JSON.stringify(doc ?? {}));
      return { ok: doc !== undefined, status: doc === undefined ? 404 : 200, json: async () => doc, arrayBuffer: async () => bytes.buffer as ArrayBuffer };
    },
    { urls: [] as string[] },
  );
  const h = harness({ store, now: Number(now), parties: castParties(), fetch: fetchDocs, deployments: { local: false, files: ['hedera.json'] } });
  const app = createApp(h.svc, { chain: null, cast: { identity, ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}) } });
  const url = await new Promise<string>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      closers.push(() => server.close());
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
  const get = async (path = '/v1/cast') => {
    const r = await fetch(`${url}${path}`);
    return { status: r.status, body: (await r.json()) as any };
  };
  return { built, get, h, url, fetchDocs };
}

const byId = (body: any) => Object.fromEntries(body.cast.members.map((m: any) => [m.agentId, m]));
const conforms = (r: { status: number; body: unknown }) => expect(check(responseSchema('/v1/cast', 'get'), r.body), JSON.stringify(r.body).slice(0, 300)).toEqual([]);

describe('GET /v1/cast', () => {
  it('lists every party with an agent id, with its registry facts, its type, its orders and its claims', async () => {
    const id = fakeIdentity(fullCast());
    const { get, built } = await boot(id.reads);
    const r = await get();
    expect(r.status).toBe(200);
    conforms(r);
    expect(r.body.meta.degraded).not.toContain('identity');
    expect(r.body.cast.registry).toEqual({ chainId: 296, address: REGISTRY, accountId: addressBook.hedera.erc8004IdentityAccountId, explorer: `https://hashscan.io/testnet/contract/${REGISTRY}` });
    expect(r.body.cast.members.map((m: any) => m.agentId)).toEqual(['149', '150', '151', '152']);
    const m = byId(r.body);
    expect(m['149']).toMatchObject({
      role: 'platform',
      displayName: 'Example Agent Co (sample)',
      address: PLATFORM,
      owner: PLATFORM,
      ownerIsParty: true,
      current: true,
      ownerExplorer: `https://hashscan.io/testnet/account/${PLATFORM}`,
      registration: { name: 'Example Agent Co (sample)', recourse: { role: 'platform', kind: 'personal-shopper', label: 'Personal shopping agent' } },
      // two distinct orders among its writer's records; the foreign payer's order is not its
      orders: 2,
    });
    expect(m['149'].agentURI.startsWith('data:application/json;base64,')).toBe(true);
    expect(m['149'].claims.map((c: any) => c.claimId).sort()).toEqual([built[0]!.claimId, built[1]!.claimId].sort());
    // the shop's document is read over HTTPS
    expect(m['150']).toMatchObject({ role: 'shop', agentURI: SHOP_DOC_URL, orders: 1, registration: { recourse: { kind: 'apparel-sizes', label: 'Physical goods with sizes' } } });
    const closed = m['150'].claims;
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ claimId: built[0]!.claimId, statusKey: 'closed_uncontested', answer: 1, findingSide: 'platform', counterparty: PLATFORM, counterpartyName: 'Example Agent Co (sample)' });
    expect(closed[0].paid).toMatch(/^[0-9]+$/);
    // a registration with no recourse object: role from the party map, type unknown
    expect(m['151']).toMatchObject({ role: 'platform', orders: 0, claims: [], registration: { name: 'Example Buying Desk (sample)', recourse: null } });
    // an owner that is not the party's own address is said so
    expect(m['152']).toMatchObject({ ownerIsParty: false, registration: { recourse: { kind: 'perishable-goods' } } });
    expect(m['152'].claims[0]).toMatchObject({ claimId: built[1]!.claimId, statusKey: 'finding_made', answer: 1, paid: null });
  });

  it('reads the registry once per refresh, not once per request', async () => {
    const id = fakeIdentity(fullCast());
    const { get, h, fetchDocs } = await boot(id.reads);
    await get();
    const first = id.calls.length;
    expect(first).toBe(8);
    await get();
    expect(id.calls.length).toBe(first);
    expect(fetchDocs.urls).toEqual([SHOP_DOC_URL]);
    h.clock.now += 31;
    await get();
    expect(id.calls.length).toBe(2 * first);
  });

  it('answers with nothing read and identity degraded while the relay fails, then with the last values read', async () => {
    const id = fakeIdentity({});
    const { get, h } = await boot(id.reads);
    const down = await get();
    expect(down.status).toBe(200);
    conforms(down);
    expect(down.body.meta.degraded).toContain('identity');
    expect(byId(down.body)['149']).toMatchObject({ owner: null, agentURI: null, registration: null, readAt: null, current: false, displayName: 'Example Agent Co (sample)', orders: 2 });
    // the relay is back
    Object.assign(id.agents, fullCast());
    h.clock.now += 31;
    const up = await get();
    expect(up.body.meta.degraded).not.toContain('identity');
    const readAt = byId(up.body)['149'].readAt;
    expect(readAt).toBe(h.clock.now);
    // and down again: the last values stand, marked as not current
    for (const k of Object.keys(id.agents)) id.agents[k] = relayDown();
    h.clock.now += 31;
    const stale = await get();
    conforms(stale);
    expect(stale.body.meta.degraded).toContain('identity');
    expect(byId(stale.body)['149']).toMatchObject({ owner: PLATFORM, readAt, current: false, registration: { recourse: { kind: 'personal-shopper' } } });
  });

  it('waits a bounded time on a slow relay and keeps the answer that lands later', async () => {
    const id = fakeIdentity(fullCast(), { delayMs: 400 });
    const { get } = await boot(id.reads, { waitMs: 50 });
    const t = Date.now();
    const slow = await get();
    expect(Date.now() - t).toBeLessThan(350);
    expect(slow.body.meta.degraded).toContain('identity');
    expect(byId(slow.body)['149'].owner).toBeNull();
    await new Promise((r) => setTimeout(r, 450));
    const later = await get();
    expect(later.body.meta.degraded).not.toContain('identity');
    expect(byId(later.body)['149'].owner).toBe(PLATFORM);
  });

  it('keeps the last document when its host does not answer, and reads none from a URI it does not fetch', async () => {
    const agents = fullCast();
    const id = fakeIdentity({ ...agents, '151': { owner: PLATFORM2, uri: 'http://127.0.0.1:8720/.well-known/agent-registration.json' } });
    const { get, h, fetchDocs } = await boot(id.reads);
    const r = await get();
    // an http: URI is an answer (nothing is fetched), not a failure
    expect(byId(r.body)['151']).toMatchObject({ registration: null, current: true });
    expect(fetchDocs.urls).toEqual([SHOP_DOC_URL]);
    expect(r.body.meta.degraded).not.toContain('identity');
    const saved = DOCS[SHOP_DOC_URL];
    delete DOCS[SHOP_DOC_URL];
    try {
      h.clock.now += 31;
      const gone = await get();
      expect(gone.body.meta.degraded).toContain('identity');
      expect(byId(gone.body)['150']).toMatchObject({ current: false, registration: { recourse: { kind: 'apparel-sizes' } } });
    } finally {
      DOCS[SHOP_DOC_URL] = saved;
    }
  });

  it('shows an agent id the registry has no agent for as unregistered, not as a failure', async () => {
    const id = fakeIdentity({ ...fullCast(), '152': reverted() });
    const { get } = await boot(id.reads);
    const r = await get();
    conforms(r);
    expect(byId(r.body)['152']).toMatchObject({ owner: null, ownerIsParty: false, agentURI: null, registration: null, current: true });
    expect(r.body.meta.degraded).not.toContain('identity');
  });

  it('with no relay configured, lists the parties and says identity is degraded', async () => {
    const { get } = await boot(null);
    const r = await get();
    expect(r.status).toBe(200);
    conforms(r);
    expect(r.body.meta.degraded).toContain('identity');
    expect(r.body.cast.members).toHaveLength(4);
  });

  it('answers the /v1 errors: rebuilding and a method it does not take', async () => {
    const { get, url } = await boot(fakeIdentity(fullCast()).reads, { rebuilding: true });
    const r = await get();
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: 'upstream_unavailable', details: { upstream: 'index', rebuilding: true } });
    const post = await fetch(`${url}/v1/cast`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(((await post.json()) as any).error.code).toBe('method_not_allowed');
  });
});

describe('registrationOf', () => {
  it('keeps a recourse object only when every field validates', () => {
    const ok = { role: 'shop', kind: 'digital-api', label: 'Digital or API service', summary: 'Pay per call (sample).' };
    expect(registrationOf({ name: ' A  shop ', description: 'd', recourse: ok })).toEqual({ name: 'A shop', description: 'd', recourse: ok });
    for (const bad of [{ ...ok, role: 'agent' }, { ...ok, kind: 'Digital API' }, { ...ok, kind: '-x' }, { ...ok, summary: '' }, { ...ok, label: 7 }, 'shop', null]) {
      expect(registrationOf({ name: 'A shop', recourse: bad }).recourse, JSON.stringify(bad)).toBeNull();
    }
    expect(registrationOf(null)).toEqual({ name: null, description: null, recourse: null });
    expect(registrationOf({ name: 'x'.repeat(500) }).name).toHaveLength(120);
  });
});
