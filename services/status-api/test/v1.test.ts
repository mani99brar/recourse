import { afterEach, describe, expect, it } from 'vitest';
import { CASE_ABI, CLAIMS_ABI, VAULT_ABI } from '../src/abi/deployed.js';
import { createApp } from '../src/app.js';
import type { ActionReads } from '../src/chain.js';
import type { Config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ACTION_NAMES } from '../src/v1/build.js';
import { ERROR_STATUS } from '../src/v1/errors.js';
import { REVERT_MAP } from '../src/v1/reverts.js';
import { Buckets, nextActionOf } from '../src/v1/router.js';
import { fakeChain } from './helpers/chain.js';
import { Sim } from './helpers/encode.js';
import { PLATFORM, SHOP, buildClaim, fakeReader, ingest, type Built, type Stage } from './helpers/fixtures.js';
import { OPENAPI, check, responseSchema } from './helpers/schema.js';
import { harness } from './helpers/service.js';
import type { Reader } from '../src/live.js';

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

async function boot(opts: { stages?: Stage[]; rebuilding?: boolean; reader?: Reader; cfg?: Partial<Config>; chain?: ActionReads | null; nowMs?: () => number; creditWaitMs?: number } = {}) {
  const sim = new Sim();
  const built: Built[] = (opts.stages ?? ['finding_made', 'contested', 'settled']).map((s, i) => buildClaim(sim, s, i + 1));
  const store = new Store();
  ingest(store, sim);
  store.rebuilding = opts.rebuilding ?? false;
  const now = built.reduce((m, b) => (b.now > m ? b.now : m), 0n);
  for (const s of ['hedera', 'arbitrum', 'hcs'] as const) store.status[s].indexedThrough = Number(now);
  const h = harness({ store, now: Number(now), reader: opts.reader ?? fakeReader(), deployments: { arbitrumChainId: 421_614 }, ...(opts.cfg ? { cfg: opts.cfg } : {}) });
  const app = createApp(h.svc, {
    chain: opts.chain === undefined ? fakeChain({ now }) : opts.chain,
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    ...(opts.creditWaitMs !== undefined ? { creditWaitMs: opts.creditWaitMs } : {}),
  });
  const url = await new Promise<string>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      closers.push(() => server.close());
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
  const get = async (path: string) => {
    const r = await fetch(`${url}${path}`);
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  };
  return { built, url, get, h, store };
}

const pathOf = (p: string) => p.replace(/\?.*$/, '');

function conformsRead(template: string, r: { status: number; body: unknown }) {
  const schema = r.status === 200 ? responseSchema(template, 'get') : { $ref: '#/components/schemas/Error' };
  expect(check(schema, r.body), JSON.stringify(r.body).slice(0, 300)).toEqual([]);
}

describe('the code agrees with openapi.json', () => {
  const contract = OPENAPI as any;

  it('has the same error codes with the same statuses', () => {
    const listed = Object.fromEntries((contract['x-recourse-error-codes'] as { code: string; status: number }[]).map((c) => [c.code, c.status]));
    expect(ERROR_STATUS).toEqual(listed);
    expect(Object.keys(ERROR_STATUS)).toHaveLength(43);
    expect(contract.components.schemas.ErrorCode.enum.slice().sort()).toEqual(Object.keys(ERROR_STATUS).sort());
  });

  it('maps the same contract errors to the same codes, and each is in the deployed ABI', () => {
    const listed = (contract['x-recourse-revert-map'] as { contract: string; error: string; code: string; status: number }[]).filter((r) => r.contract !== '*');
    expect(REVERT_MAP.map((r) => [r.contract, r.error, r.code])).toEqual(listed.map((r) => [r.contract, r.error, r.code]));
    for (const r of listed) expect(ERROR_STATUS[r.code as keyof typeof ERROR_STATUS]).toBe(r.status);
    const abiOf = { RecourseClaims: CLAIMS_ABI, DepositVault: VAULT_ABI, RecourseCase: CASE_ABI } as const;
    for (const r of REVERT_MAP) {
      const sigs = abiOf[r.contract as keyof typeof abiOf].filter((x) => x.type === 'error').map((x: any) => `${x.name}(${x.inputs.map((i: any) => i.type).join(',')})`);
      expect(sigs, `${r.contract}.${r.error}`).toContain(r.error);
    }
  });

  it('builds the same twelve actions the contract lists, each with a call that exists', () => {
    const paths = Object.keys(contract.paths).filter((p) => p.startsWith('/v1/actions/')).map((p) => p.slice('/v1/actions/'.length));
    expect([...ACTION_NAMES]).toEqual(paths);
    expect([...ACTION_NAMES]).toEqual(contract.components.schemas.ActionName.enum);
    for (const p of paths) {
      const errors: string[] = contract.paths[`/v1/actions/${p}`].post['x-recourse-errors'];
      for (const code of errors) expect(ERROR_STATUS, `${p}: ${code}`).toHaveProperty(code);
    }
  });
});

describe('/v1 reads', () => {
  it('answers each read as { <resource>, meta } in the contract\'s shapes', async () => {
    const { built, get } = await boot();
    const [b1] = built;
    const reads: [string, string, string][] = [
      ['/v1/health', '/v1/health', 'health'],
      ['/v1/params', '/v1/params', 'params'],
      ['/v1/claims', '/v1/claims', 'claims'],
      [`/v1/claims?party=${SHOP}`, '/v1/claims', 'claims'],
      ['/v1/claims?status=contested', '/v1/claims', 'claims'],
      [`/v1/claims/${b1!.claimId}`, '/v1/claims/{claimId}', 'claim'],
      [`/v1/parties/${PLATFORM}`, '/v1/parties/{address}', 'party'],
      [`/v1/orders/${b1!.orderId}/records`, '/v1/orders/{orderId}/records', 'order'],
      [`/v1/orders/${b1!.orderId}/records?platform=${PLATFORM}&shop=${SHOP}`, '/v1/orders/{orderId}/records', 'order'],
      [`/v1/search?q=${b1!.claimId}`, '/v1/search', 'search'],
    ];
    for (const [path, template, key] of reads) {
      const r = await get(path);
      expect(r.status, `${path}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
      expect(r.body).toHaveProperty(key);
      expect(r.body.meta).toMatchObject({ apiVersion: '1' });
      conformsRead(template, r);
      void pathOf;
    }
  });

  it('marks each row with the action that builds its next call', async () => {
    const fresh = await boot({ stages: ['finding_made'] });
    expect((await fresh.get('/v1/claims')).body.claims[0].nextAction).toMatchObject({ action: 'contest', path: '/v1/actions/contest', actor: 'platform' });
    expect((await fresh.get(`/v1/claims/${fresh.built[0]!.claimId}`)).body.claim.nextAction).toMatchObject({ action: 'contest' });
    // one clock for all three claims: by the time the last is settled, the first one's window has lapsed
    const { built, get } = await boot();
    const r = await get('/v1/claims');
    const byId = Object.fromEntries(r.body.claims.map((c: any) => [c.claimId, c]));
    expect(byId[built[0]!.claimId].nextAction).toMatchObject({ action: 'closeUncontested', path: '/v1/actions/closeUncontested', actor: 'anyone' });
    expect(byId[built[1]!.claimId].nextAction).toMatchObject({ action: 'sendToCourt', path: '/v1/actions/sendToCourt' });
    // settled, and the shop has no credit left in the vault: nothing is left to build
    expect(byId[built[2]!.claimId].nextCall).toBe('withdrawCredit');
    expect(byId[built[2]!.claimId].nextAction).toBeNull();
    expect((await get(`/v1/claims/${built[2]!.claimId}`)).body.claim.nextAction).toBeNull();
    // with credit in the vault, what is left is the shop taking it out
    const party0 = { deposit: 100_000_000n, required: 10_000_000n, credit: 2_500_000n, topUpDeadline: 0n, inGoodStanding: true, openClaims: 0n, exitRequestedAt: 0n, shopEscrow: 0n };
    const credited = await boot({ reader: fakeReader({ party: async () => party0 }) });
    const settledId = credited.built[2]!.claimId;
    const rows = Object.fromEntries((await credited.get('/v1/claims')).body.claims.map((c: any) => [c.claimId, c]));
    expect(rows[settledId].nextAction).toMatchObject({ action: 'withdrawCredit', path: '/v1/actions/withdrawCredit', actor: 'shop', deadline: null });
    expect((await credited.get(`/v1/claims/${settledId}`)).body.claim.nextAction).toMatchObject({ action: 'withdrawCredit' });
    expect((await credited.get(`/v1/claims?party=${SHOP}`)).body.claims.find((c: any) => c.claimId === settledId).nextAction).toMatchObject({ action: 'withdrawCredit' });
    const party = await get(`/v1/claims?party=${SHOP}`);
    expect(party.body.party).toHaveProperty('standing');
    expect(party.body.party).toHaveProperty('groups');
    expect((await get('/v1/claims')).body.party).toBeNull();
  });

  it('waits a bounded time on a slow credit read, then answers with the last credit read', async () => {
    const party0 = { deposit: 100_000_000n, required: 10_000_000n, credit: 2_500_000n, topUpDeadline: 0n, inGoodStanding: true, openClaims: 0n, exitRequestedAt: 0n, shopEscrow: 0n };
    let delayMs = 400;
    let reads = 0;
    const reader = fakeReader({ party: () => (reads++, new Promise<typeof party0>((resolve) => setTimeout(() => resolve({ ...party0 }), delayMs))) });
    const { built, get } = await boot({ reader, creditWaitMs: 50 });
    const settledId = built[2]!.claimId;
    // nothing read yet and the relay slower than the wait: no withdrawCredit, and no answer held up for the read
    let t = Date.now();
    expect((await get(`/v1/claims/${settledId}`)).body.claim.nextAction).toBeNull();
    expect((await get('/v1/claims')).body.claims.find((c: any) => c.claimId === settledId).nextAction).toBeNull();
    expect(Date.now() - t).toBeLessThan(delayMs);
    // the slow read lands in the background and is kept: a later slow read answers with it
    await new Promise((r) => setTimeout(r, delayMs + 50));
    t = Date.now();
    expect((await get(`/v1/claims/${settledId}`)).body.claim.nextAction).toMatchObject({ action: 'withdrawCredit' });
    expect((await get('/v1/claims')).body.claims.find((c: any) => c.claimId === settledId).nextAction).toMatchObject({ action: 'withdrawCredit' });
    expect(Date.now() - t).toBeLessThan(delayMs);
    // one read at a time: once the running one lands, a quick read is taken as it is, and the
    // credit gone to zero hides it again
    await new Promise((r) => setTimeout(r, delayMs + 50));
    delayMs = 0;
    party0.credit = 0n;
    expect((await get(`/v1/claims/${settledId}`)).body.claim.nextAction).toBeNull();
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('has no next action for calls it does not build', () => {
    for (const nextCall of ['recordPreCheck', 'manualExecute', null]) expect(nextActionOf({ nextCall, nextActor: 'precheck', deadline: null })).toBeNull();
    expect(nextActionOf({ nextCall: 'settle', nextActor: 'anyone', deadline: 5n })).toEqual({ action: 'settle', actor: 'anyone', path: '/v1/actions/settle', deadline: 5n });
    // withdrawCredit only for credit read and above zero
    const settled = { nextCall: 'withdrawCredit', nextActor: 'shop', deadline: null };
    for (const credit of [undefined, null, 0n]) expect(nextActionOf(settled, credit)).toBeNull();
    expect(nextActionOf(settled, 1n)).toMatchObject({ action: 'withdrawCredit', actor: 'shop' });
  });

  it('shows the contest window the claim was filed under, not the current one', async () => {
    const reader = fakeReader({ claimTerms: async () => ({ contestWindow: 1800n, claimTimeout: 20_000n, handling: 17_000_000n }) });
    const { built, get } = await boot({ stages: ['finding_made'], reader });
    const r = await get(`/v1/claims/${built[0]!.claimId}`);
    expect(r.status).toBe(200);
    const preCheckedAt = BigInt(r.body.claim.precheck.preCheckedAt);
    expect(r.body.claim.contest.windowEndsAt).toBe((preCheckedAt + 1800n).toString());
    const legacy = await get(`/claims/${built[0]!.claimId}`);
    expect(legacy.body.contest.windowEndsAt).toBe((preCheckedAt + 1800n).toString());
  });

  it('keeps the current window when the terms cannot be read', async () => {
    const { built, get } = await boot({ stages: ['finding_made'] });
    const r = await get(`/v1/claims/${built[0]!.claimId}`);
    expect(r.body.claim.contest.windowEndsAt).toBe((BigInt(r.body.claim.precheck.preCheckedAt) + 600n).toString());
  });

  it('stops asking for terms once the claims contract reverts claimTermsOf, and keeps the current window', async () => {
    // A claims contract from before per-claim terms has no claimTermsOf; viem reports the revert so.
    const reverted = () => Object.assign(new Error('The contract function "claimTermsOf" reverted.'), { name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionRevertedError' } });
    const reader = fakeReader({ claimTerms: async () => { throw reverted(); } }) as Reader & { calls: string[] };
    const { built, get, h } = await boot({ stages: ['finding_made', 'contested'], reader });
    const termReads = () => reader.calls.filter((c) => c.startsWith('claimTerms:')).length;
    expect((await get('/v1/claims')).status).toBe(200);
    const first = termReads();
    expect(first).toBeGreaterThan(0);
    h.clock.now += 120;
    expect((await get('/v1/claims')).status).toBe(200);
    const r = await get(`/v1/claims/${built[0]!.claimId}`);
    expect(termReads()).toBe(first);
    expect(r.body.claim.contest.windowEndsAt).toBe((BigInt(r.body.claim.precheck.preCheckedAt) + 600n).toString());
  });

  it('asks again after a minute when a terms read fails for any other reason', async () => {
    const reader = fakeReader() as Reader & { calls: string[] };
    const { get, h } = await boot({ stages: ['finding_made'], reader });
    const termReads = () => reader.calls.filter((c) => c.startsWith('claimTerms:')).length;
    await get('/v1/claims');
    const first = termReads();
    h.clock.now += 61;
    await get('/v1/claims');
    expect(termReads()).toBeGreaterThan(first);
  });

  it('answers typed errors: invalid_field, missing_field, not_found and method_not_allowed', async () => {
    const { built, get, url } = await boot();
    const cases: [string, number, string, Record<string, unknown>][] = [
      ['/v1/claims/0x12', 400, 'invalid_field', { field: 'claimId' }],
      [`/v1/claims/0x${'ab'.repeat(32)}`, 404, 'not_found', { resource: 'claim' }],
      ['/v1/claims?status=nonsense', 400, 'invalid_field', { field: 'status' }],
      ['/v1/claims?party=0x12', 400, 'invalid_field', { field: 'party' }],
      ['/v1/parties/nope', 400, 'invalid_field', { field: 'address' }],
      [`/v1/orders/${built[0]!.orderId}/records?platform=${PLATFORM}`, 400, 'missing_field', { field: 'shop' }],
      ['/v1/search', 400, 'missing_field', { field: 'q' }],
      ['/v1/search?q=%20', 400, 'invalid_field', { field: 'q' }],
      [`/v1/search?q=${'a'.repeat(201)}`, 400, 'invalid_field', { field: 'q' }],
      ['/v1/nothing', 404, 'not_found', { resource: 'route' }],
      ['/v1/actions/transferOwnership', 404, 'not_found', { resource: 'route' }],
    ];
    for (const [path, status, code, details] of cases) {
      const r = await get(path);
      expect(r.status, path).toBe(status);
      expect(r.body.error.code, path).toBe(code);
      expect(r.body.error.details, path).toMatchObject(details);
      expect(check({ $ref: '#/components/schemas/Error' }, r.body)).toEqual([]);
    }
    const post = await fetch(`${url}/v1/claims`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(((await post.json()) as any).error.code).toBe('method_not_allowed');
    const getAction = await fetch(`${url}/v1/actions/contest`);
    expect(getAction.status).toBe(405);
    // the unversioned routes keep their own answers
    const legacy = await fetch(`${url}/claims`, { method: 'POST' });
    expect(legacy.status).toBe(405);
    expect(await legacy.json()).toEqual({ error: 'read_only' });
  });

  it('answers 503 upstream_unavailable (index) while rebuilding, but /v1/health still answers', async () => {
    const { get } = await boot({ rebuilding: true });
    const r = await get('/v1/claims');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: 'upstream_unavailable', details: { upstream: 'index', rebuilding: true } });
    const h = await get('/v1/health');
    expect(h.status).toBe(200);
    expect(h.body.health.rebuilding).toBe(true);
  });

  it('serves the OpenAPI file at /openapi.json and /v1/openapi.json', async () => {
    const { get } = await boot();
    for (const p of ['/openapi.json', '/v1/openapi.json']) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/application\/json/);
      expect(r.body.openapi).toBe(OPENAPI.openapi);
      expect(Object.keys(r.body.paths)).toEqual(Object.keys(OPENAPI.paths));
    }
  });

  it('answers a CORS preflight for POST on /v1 and GET only elsewhere', async () => {
    const { url } = await boot({ cfg: { webOrigin: 'https://recourse.example' } });
    const v1 = await fetch(`${url}/v1/actions/contest`, { method: 'OPTIONS' });
    expect(v1.status).toBe(204);
    expect(v1.headers.get('access-control-allow-origin')).toBe('https://recourse.example');
    expect(v1.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(v1.headers.get('access-control-allow-headers')).toBe('content-type');
    const legacy = await fetch(`${url}/claims`, { method: 'OPTIONS' });
    expect(legacy.headers.get('access-control-allow-methods')).toBe('GET');
  });
});

describe('/v1/actions request handling', () => {
  const contestBody = (b: Built) => JSON.stringify({ from: PLATFORM, claimId: b.claimId });

  it('reads the body as JSON without a content type, and refuses what is not a JSON object', async () => {
    const { built, url } = await boot();
    const plain = await fetch(`${url}/v1/actions/contest`, { method: 'POST', body: contestBody(built[0]!) });
    const plainBody = (await plain.json()) as any;
    // the fake chain has no claim on record, so the action reaches the chain read and answers not_found
    expect(plain.status, JSON.stringify(plainBody)).toBe(404);
    expect(plainBody.error.details.resource).toBe('claim');
    for (const bad of ['{not json', '[1,2]', '"text"', 'null']) {
      const r = await fetch(`${url}/v1/actions/contest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bad });
      expect(r.status, bad).toBe(400);
      expect(((await r.json()) as any).error.code, bad).toBe('bad_json');
    }
  });

  it('refuses a body over 64 KB with payload_too_large', async () => {
    const { url } = await boot();
    const r = await fetch(`${url}/v1/actions/submitEvidence`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: SHOP, description: 'x'.repeat(70_000) }) });
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error).toMatchObject({ code: 'payload_too_large', details: { max: 65536 } });
  });

  it('limits actions per client, with Retry-After', async () => {
    let t = 1_000_000;
    const { built, url } = await boot({ cfg: { actionsPerMin: 6, actionBurst: 2 }, nowMs: () => t });
    const post = (ip: string) => fetch(`${url}/v1/actions/contest`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: contestBody(built[0]!) });
    expect((await post('203.0.113.1')).status).toBe(404);
    expect((await post('203.0.113.1')).status).toBe(404);
    const limited = await post('203.0.113.1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('10');
    expect(((await limited.json()) as any).error).toMatchObject({ code: 'rate_limited', details: { retryAfterS: 10 } });
    // another client has its own bucket
    expect((await post('203.0.113.2')).status).toBe(404);
    t += 10_000;
    expect((await post('203.0.113.1')).status).toBe(404);
  });

  it('answers upstream_unavailable when no chain reads are configured', async () => {
    const { built, url } = await boot({ chain: null });
    const r = await fetch(`${url}/v1/actions/contest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: contestBody(built[0]!) });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error.details).toMatchObject({ upstream: 'hedera_rpc' });
  });

  it('answers upstream_unavailable when the chain does not answer before the deadline', async () => {
    const slow = fakeChain();
    slow.claim = () => new Promise(() => undefined);
    const { built, url } = await boot({ chain: slow, cfg: { actionDeadlineMs: 50 } });
    const r = await fetch(`${url}/v1/actions/contest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: contestBody(built[0]!) });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error.details).toMatchObject({ upstream: 'hedera_rpc', reason: 'the chain did not answer in time' });
  });

  it('a token bucket refills at its rate and never above its burst', () => {
    let t = 0;
    const b = new Buckets(60, 3, () => t);
    expect([b.take('a').ok, b.take('a').ok, b.take('a').ok, b.take('a').ok]).toEqual([true, true, true, false]);
    t += 1000;
    expect(b.take('a').ok).toBe(true);
    expect(b.take('a')).toEqual({ ok: false, retryAfterS: 1 });
    t += 3_600_000;
    expect([b.take('a').ok, b.take('a').ok, b.take('a').ok, b.take('a').ok]).toEqual([true, true, true, false]);
  });
});
