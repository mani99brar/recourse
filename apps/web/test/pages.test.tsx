import { readdirSync, readFileSync } from 'node:fs';
import { CIRCLE_VAULT_TOKEN, STATUS_KEYS, vaultTokenOf } from '@recourse/shared';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shell, route } from '../src/App.js';
import { Banner, lateWords } from '../src/components.js';
import { ApiFailure, READS, failureFrom, fromV1, isRebuilding } from '../src/lib/api.js';
import { mockNote, parseUsdc, usdc } from '../src/lib/format.js';
import { ACTOR_WORDS, CALL_WORDS, FATE_WORDS, GROUP_WORDS, REASON_WORDS, STATUS_WORDS } from '../src/lib/words.js';
import { CaseView, type CaseDetail } from '../src/pages/Case.js';
import { Finding, chainNote, standingWords } from '../src/pages/File.js';
import { ClaimList } from '../src/pages/Party.js';
import { LocalStoreNote, RateTable } from '../src/pages/Docket.js';
import { uncontestedFrom } from '../src/lib/arkiv.js';
import { REASON_KEYS } from '@recourse/shared';
import { faultRates } from '@recourse/docket';

function detail(statusKey: CaseDetail['statusKey'], over: Partial<CaseDetail> = {}): CaseDetail {
  return {
    claimId: '0x' + '11'.repeat(32), orderId: '0x' + '22'.repeat(32), shop: '0x' + '33'.repeat(20), shopName: 'Example Shop (sample)',
    platform: '0x' + '44'.repeat(20), platformName: 'Example Agent Co (sample)', filedAt: '1700000000', statusKey, nextActor: 'anyone', nextCall: 'settle',
    deadline: null, findingSide: 'platform', gap: 1, answer: 1, basketUsdc: '60000000', netLossUsdc: '50000000', refs: { hashes: [] },
    records: [0, 1, 2, 3, 4, 5].map((kind) => ({ kind, seq: kind + 1, cid: `bafysample${kind}`, hash: '0x' + '00'.repeat(32), payerOk: true, held: true, hashOk: true, refsMatch: true })),
    precheck: { gap: 1, answer: 1, side: 'platform', packHash: '0x' + '55'.repeat(32), packHashOk: true },
    contest: { by: null, at: null, windowEndsAt: '1700000600' },
    court: { state: 'none', attempts: 0, disputeIds: [], period: null, periodName: null, currentRuling: null, tied: null, overridden: null, ruling: null, evidence: [], courtLinks: [] },
    messages: [], money: { owed: null, paid: null, credited: null, notCovered: null, escrow: { amount: '3000000', fate: 'held' }, projected: false },
    docket: { writeStatus: 'none', entityKey: null, store: null }, events: [{ name: 'ClaimFiled', chain: 'hedera', tx: '0x' + '66'.repeat(32), time: '1700000000', explorer: null }],
    ...over,
  };
}

describe('words', () => {
  it('has a word for every status key, actor, call, reason and group', () => {
    for (const k of STATUS_KEYS) expect(STATUS_WORDS[k].title.length).toBeGreaterThan(0);
    for (const k of REASON_KEYS) expect(REASON_WORDS[k]).toBeTruthy();
    expect(Object.keys(ACTOR_WORDS)).toHaveLength(7);
    expect(Object.keys(CALL_WORDS)).toHaveLength(12);
    expect(Object.keys(FATE_WORDS)).toContain('kept_by_pool');
    expect(Object.keys(GROUP_WORDS)).toHaveLength(5);
  });
});

describe('pages render', () => {
  for (const k of STATUS_KEYS) {
    it(`case page for ${k}`, () => {
      const html = renderToString(<CaseView d={detail(k)} />);
      expect(html).toContain(STATUS_WORDS[k].title);
      // With no wallet in the page there is nothing to connect, and the claim still reads in full.
      expect(html).not.toContain('Connect wallet');
    });
  }
  it('shows a stuck claim with its next call', () => {
    expect(renderToString(<CaseView d={detail('stuck', { nextCall: 'resend' })} />)).toContain('resend the message');
  });
  it('a ruling on its way back is never shown with advice to end the claim', () => {
    const stuckBack = renderToString(<CaseView d={detail('stuck', { nextCall: 'relayRuling' })} />);
    expect(stuckBack).toContain('send the ruling back');
    expect(stuckBack).not.toContain('end the claim after the timeout');
    expect(stuckBack).toContain('throw the ruling away');
    const court = detail('at_court').court;
    const inFlight = renderToString(<CaseView d={detail('at_court', { nextActor: 'none', nextCall: null, court: { ...court, state: 'relayed' } })} />);
    expect(inFlight).toContain('on its way back to Hedera');
    expect(inFlight).not.toContain('end the claim');
    const failedBack = renderToString(<CaseView d={detail('stuck', { nextCall: 'manualExecute', court: { ...court, state: 'relayed' } })} />);
    expect(failedBack).toContain('run the failed message by hand');
    expect(failedBack).toContain('throw the ruling away');
    expect(failedBack).not.toContain('end the claim after the timeout');
  });
  it('a referenced record the topic has not been read to yet is unchecked, not "not on the topic"', () => {
    const base = detail('at_court');
    const records = base.records.map((r) => (r.kind === 5 ? { ...r, cid: null, seq: 6, held: null, hashOk: null, payerOk: false, refsMatch: false, unread: true } : r));
    const html = renderToString(<CaseView d={{ ...base, records }} />);
    expect(html).toContain('listed (#6), not read from the topic yet');
    expect(html).not.toContain('not on the topic');
    expect(html).toContain('unchecked');
  });
  it('shows an unpaid shortfall apart from paid', () => {
    const html = renderToString(<CaseView d={detail('settled', { money: { owed: '68000000', paid: '20000000', credited: '20000000', notCovered: '48000000', escrow: { amount: '3000000', fate: 'kept_by_pool' }, projected: false } })} />);
    expect(html).toContain('48.00 USDC');
    expect(html).toContain('20.00 USDC');
  });
  it('labels every vault amount with the deployment token, and the mock as a testnet mock', () => {
    const mock = vaultTokenOf({ usdc: { mode: 'mock', address: '0x' + '11'.repeat(20), decimals: 6, tokenId: null } });
    const money = { owed: '68000000', paid: '20000000', credited: '20000000', notCovered: '48000000', escrow: { amount: '3000000', fate: 'kept_by_pool' }, projected: false };
    const html = renderToString(<CaseView d={detail('settled', { money, vaultToken: mock })} />);
    for (const amount of ['60.00', '50.00', '68.00', '48.00', '20.00', '3.00']) expect(html).toContain(`${amount} mUSDC (testnet mock)`);
    expect(html).not.toMatch(/\d USDC/);
    expect(renderToString(<CaseView d={detail('settled', { money, vaultToken: CIRCLE_VAULT_TOKEN })} />)).toContain('48.00 USDC');
    expect(renderToString(<Banner fresh={{ vaultToken: mock }} />)).toContain('testnet mock of USDC');
    expect(renderToString(<Banner token={mock} />)).toContain('worth nothing');
    expect(renderToString(<Banner fresh={{ vaultToken: CIRCLE_VAULT_TOKEN }} />)).toBe('');
  });
  it('says what the owner can still change until the contracts are locked, and nothing after', () => {
    const notice = 'Not every contract is locked yet. Until it is, the owner can change things.';
    expect(renderToString(<Banner fresh={{ configLock: { allLocked: false, notice } }} />)).toContain('Not every contract is locked yet');
    expect(renderToString(<Banner fresh={{ configLock: { allLocked: true, notice: null } }} />)).toBe('');
    expect(renderToString(<CaseView d={detail('at_court')} />)).not.toContain('locked');
  });
  it('names each late source and how far behind it is', () => {
    const now = 1_700_000_000_000;
    const asOf = { hedera: 1_700_000_000 - 240, arbitrum: 1_700_000_000 - 30, hcs: null };
    expect(lateWords('hedera', asOf, now)).toBe('Hedera (4 min behind)');
    expect(lateWords('arbitrum', asOf, now)).toBe('Arbitrum (30 s behind)');
    expect(lateWords('hcs', asOf, now)).toBe('the records topic (not read through yet)');
    expect(renderToString(<Banner fresh={{ degraded: ['hcs'], asOf }} />)).toContain('the records topic (not read through yet)');
  });
  it('degraded and unreachable states show a banner, not a crash', () => {
    expect(renderToString(<Banner fresh={{ degraded: ['hedera'] }} />)).toContain('running late');
    expect(renderToString(<Banner error={new ApiFailure(0, 'unreachable')} />)).toContain('cannot be reached');
    expect(renderToString(<Banner error={new ApiFailure(503, 'rebuilding')} />)).toContain('rebuilding');
  });
  it('the docket counts uncontested closures from the monthly counts, and says when they were not read', () => {
    const P = '0x' + 'AA'.repeat(20);
    const S = '0x' + 'BB'.repeat(20);
    const counts = uncontestedFrom([
      { platform: { value: P }, shop: { value: S }, closedUncontested: { value: 2 } },
      { platform: { value: P }, shop: { value: S }, closedUncontested: { value: 1 } },
      { platform: { value: P }, shop: { value: S }, closedUncontested: { value: 0 } },
    ]);
    expect(counts).toEqual({ platform: { [P.toLowerCase()]: 3 }, shop: { [S.toLowerCase()]: 3 } });
    const rates = faultRates([], { closedUncontested: counts });
    expect(rates.find((r) => r.role === 'platform')!.closedUncontested).toBe(3);
    const html = renderToString(<RateTable rates={rates} />);
    expect(html).toContain('>3<!-- --> <span');
    const unread = renderToString(<RateTable rates={faultRates([{ platform: P, shop: S, outcome: 1, unresolved: false, inclusionBps: 10000 }])} countsRead={false} />);
    expect(unread).toContain('not read');
    expect(renderToString(<LocalStoreNote />)).toContain('not on Arkiv');
  });
  it('renders every route shell and an empty docket', () => {
    for (const h of ['#/', '#/docket', '#/file', '#/claim/0x12', '#/party/0x12']) expect(renderToString(<Shell hash={h} />)).toContain('Recourse');
    expect(renderToString(<RateTable rates={[]} />)).toContain('No ruled cases');
    expect(renderToString(<ClaimList rows={[]} />)).toContain('No claims');
  });
  it('a deposit that could not be read is unknown, never "not in good standing"', () => {
    const unread = standingWords({ role: 'platform', displayName: null, balance: null, required: null, inGoodStanding: null });
    expect(unread).toContain('not read right now');
    expect(unread).not.toContain('not in good standing');
    expect(standingWords({ role: 'platform', displayName: null, balance: '5000000', required: '10000000', inGoodStanding: false })).toBe('not in good standing; holds 5.00 USDC of 10.00 USDC required');
    expect(standingWords({ role: 'platform', displayName: null, balance: '20000000', required: '10000000', inGoodStanding: true })).toContain('in good standing; holds 20.00');
    // Built-in defaults are labelled as such; live values carry no label.
    expect(chainNote(true)).toContain('default, not read from the chain');
    expect(chainNote(false)).toBe('');
    expect(chainNote(undefined)).toBe('');
  });
  it('explains a finding in plain words', () => {
    const html = renderToString(<Finding result={{ gap: 255, answer: 0, side: 'none', reasonKey: 'not_enough_record', step: '1', flaggedCells: [], notCompared: [], unreadPrice: [] }} />);
    expect(html).toContain('not enough records');
    expect(html).toContain('No finding');
  });
});

describe('deadlines', () => {
  it('labels the filed and contested expiry in plain words', () => {
    const f = renderToString(<CaseView d={detail('filed', { nextActor: 'preCheckSigner', nextCall: 'recordPreCheck', deadline: '1700014400' })} />);
    expect(f).toContain('Expires if not pre-checked by');
    expect(f).toContain('2023-11-14');
    const c = renderToString(<CaseView d={detail('contested', { nextCall: 'sendToCourt', deadline: '1700014400' })} />);
    expect(c).toContain('Expires if no ruling by');
  });
  it('renders with no deadline at all', () => {
    const html = renderToString(<CaseView d={detail('settled', { nextCall: null, deadline: null })} />);
    expect(html).not.toContain('Expires');
  });
});

describe('helpers', () => {
  it('routes hashes', () => {
    expect(route('#/claim/0xab')).toEqual({ name: 'claim', arg: '0xab' });
    expect(route('#/nothing').name).toBe('home');
  });
  it('formats and parses amounts', () => {
    expect(usdc('3000000')).toBe('3.00 USDC');
    expect(usdc('3000000', CIRCLE_VAULT_TOKEN)).toBe('3.00 USDC');
    expect(usdc(1_234_560_000n, { label: 'mUSDC (testnet mock)' })).toBe('1,234.56 mUSDC (testnet mock)');
    expect(usdc(null, { label: 'mUSDC (testnet mock)' })).toBe('not yet known');
    // Exact, never truncated: a sub-cent shortfall is not 0.00, and a handling fee keeps its decimals.
    expect(usdc('4000')).toBe('0.004 USDC');
    expect(usdc('51617283')).toBe('51.617283 USDC');
    expect(usdc('1075000')).toBe('1.075 USDC');
    expect(usdc('1')).toBe('0.000001 USDC');
    expect(usdc('0')).toBe('0.00 USDC');
    expect(usdc('12500000')).toBe('12.50 USDC');
    expect(mockNote({ mode: 'mock' })).toContain('mUSDC');
    expect(mockNote({ mode: 'circle' })).toBeNull();
    expect(mockNote(undefined)).toBeNull();
    expect(parseUsdc('12.5')).toBe(12_500_000n);
    expect(parseUsdc('-1')).toBeNull();
    expect(parseUsdc('1.1234567')).toBeNull();
  });
});

type Schema = { $ref?: string; properties?: Record<string, Schema>; required?: string[] };
const root = new URL('../../../', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('services/status-api/openapi.json', root), 'utf8')) as {
  paths: Record<string, { get?: { responses: Record<string, { content: Record<string, { schema: Schema }> }> } }>;
  components: { schemas: Record<string, Schema> };
};
const deref = (x: Schema): Schema => (x.$ref ? deref(spec.components.schemas[x.$ref.split('/').pop()!]!) : x);

describe('the read pages call the documented /v1 API, as the agents do', () => {
  const ID = '0x' + 'ab'.repeat(32);
  const ADDR = '0x' + 'cd'.repeat(20);
  const reads = [READS.claims(), READS.partyClaims(ADDR), READS.claim(ID), READS.party(ADDR), READS.params(), READS.search('order 1'), READS.orderRecords(ID)];
  const templateOf = (path: string) =>
    Object.keys(spec.paths).find((t) => spec.paths[t]!.get && new RegExp(`^${t.replace(/\{[^}]+\}/g, '[^/?]+')}$`).test(path.split('?')[0]!)) ?? null;

  it('every path the pages read is a GET in openapi.json under /v1', () => {
    for (const p of reads) {
      expect(p.startsWith('/v1/'), p).toBe(true);
      expect(templateOf(p), p).not.toBeNull();
    }
  });

  it('each of those answers is { <key>, meta } (or { claims, party, meta }), with the freshness in meta', () => {
    for (const p of reads) {
      const schema = deref(spec.paths[templateOf(p)!]!.get!.responses['200']!.content['application/json']!.schema);
      const keys = Object.keys(schema.properties ?? {}).sort();
      expect(keys.includes('meta') && (keys.length === 2 || keys.join() === 'claims,meta,party'), `${p}: ${keys.join()}`).toBe(true);
      const meta = Object.keys(deref(schema.properties!.meta!).properties ?? {});
      for (const k of ['asOf', 'degraded', 'vaultToken', 'configLock']) expect(meta, p).toContain(k);
    }
  });

  it('no page reads an unversioned path', () => {
    const dir = new URL('../src/pages/', import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, f).not.toMatch(/(usePoll|getApi|getRead)(<[^>]*>)?\(\s*[`'"]\//);
    }
  });

  it('unwraps each /v1 read into the value with its freshness beside it', () => {
    const meta = { apiVersion: '1', asOf: { hedera: 1, arbitrum: 2, hcs: 3 }, degraded: ['hcs'], vaultToken: { mode: 'mock' }, configLock: { allLocked: false, notice: 'n' } };
    const fresh = { asOf: meta.asOf, degraded: meta.degraded, vaultToken: meta.vaultToken, configLock: meta.configLock };
    expect(fromV1({ claims: [{ claimId: 'x' }], party: null, meta })).toEqual({ rows: [{ claimId: 'x' }], ...fresh });
    expect(fromV1({ claims: [], party: { standing: { role: 'shop' }, groups: { finished: [] } }, meta })).toEqual({ rows: [], standing: { role: 'shop' }, groups: { finished: [] }, ...fresh });
    expect(fromV1({ claim: { claimId: 'x', statusKey: 'settled' }, meta })).toEqual({ claimId: 'x', statusKey: 'settled', ...fresh });
    expect(fromV1({ params: { params: { claims: {} }, schemeWallet: null, actions: ['settle'] }, meta })).toEqual({ params: { claims: {} }, schemeWallet: null, actions: ['settle'], ...fresh });
    expect(fromV1({ party: { role: 'platform', balance: '1' }, meta })).toEqual({ role: 'platform', balance: '1', ...fresh });
    expect(fromV1({ search: { hits: [] }, meta })).toEqual({ hits: [], ...fresh });
    expect(fromV1({ order: { orderId: 'o', claimId: null, records: [] }, meta })).toEqual({ orderId: 'o', claimId: null, records: [], ...fresh });
    expect(fromV1({ claim: {}, meta })).not.toHaveProperty('apiVersion');
  });

  it('reads a v1 rebuild as rebuilding, and another unavailable source as unreachable', () => {
    const rebuilding = failureFrom(503, { error: { code: 'upstream_unavailable', message: 'The index is rebuilding.', details: { upstream: 'index', rebuilding: true } } });
    expect(isRebuilding(rebuilding)).toBe(true);
    expect(renderToString(<Banner error={rebuilding} />)).toContain('rebuilding its index');
    const down = failureFrom(503, { error: { code: 'upstream_unavailable', message: 'Hedera is not answering.', details: { upstream: 'hedera_rpc' } } });
    expect(isRebuilding(down)).toBe(false);
    expect(renderToString(<Banner error={down} />)).toContain('cannot be reached');
  });
});

/**
 * usePoll as a page renders it, driven by a stand-in for React's hooks (these tests have no DOM): state and refs
 * keep their slot from one render to the next, and an effect whose deps changed runs after the last one's cleanup.
 * fetch answers each path from `answers`: a body, a failing status, or a promise the test settles itself.
 */
async function pollPage(answers: Record<string, unknown>) {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = Object.keys(answers).find((p) => url.endsWith(p));
    const a = path === undefined ? 404 : answers[path];
    const body = a instanceof Promise ? await a : a;
    if (typeof body === 'number') return { ok: false, status: body, json: async () => ({ error: { code: 'upstream_unavailable', message: 'down' } }) };
    return { ok: true, status: 200, json: async () => body };
  });
  const slots: unknown[] = [];
  const effects = new Set<number>();
  let at = 0;
  let due: (() => void)[] = [];
  type Effect = { deps: unknown[]; cleanup: (() => void) | void };
  vi.resetModules();
  vi.doMock('react', async (real: () => Promise<typeof import('react')>) => ({
    ...(await real()),
    useState: (init: unknown) => {
      const k = at++;
      if (!(k in slots)) slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [slots[k], (v: unknown) => void (slots[k] = typeof v === 'function' ? (v as (s: unknown) => unknown)(slots[k]) : v)];
    },
    useRef: (init: unknown) => {
      const k = at++;
      if (!(k in slots)) slots[k] = { current: init };
      return slots[k];
    },
    useEffect: (fn: () => (() => void) | void, deps: unknown[]) => {
      const k = at++;
      const last = slots[k] as Effect | undefined;
      if (last && deps.every((d, j) => Object.is(d, last.deps[j]))) return;
      effects.add(k);
      due.push(() => {
        last?.cleanup?.();
        slots[k] = { deps, cleanup: fn() } satisfies Effect;
      });
    },
  }));
  const { usePoll } = await import('../src/lib/api.js');
  vi.doUnmock('react');
  return {
    /** One render for `path` and then its effects; what the page shows in that render. */
    render(path: string | null, ms?: number) {
      at = 0;
      const seen = usePoll<{ claimId: string }>(path, ms);
      const run = due;
      due = [];
      for (const f of run) f();
      return seen;
    },
    /** The page goes away: each effect's cleanup runs. */
    leave() {
      for (const k of effects) (slots[k] as Effect).cleanup?.();
    },
  };
}
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('a page moved to another claim or party', () => {
  const A = READS.claim('0x' + 'aa'.repeat(32));
  const B = READS.claim('0x' + 'bb'.repeat(32));
  const claimA = { claim: { claimId: 'A' }, meta: {} };
  afterEach(() => vi.unstubAllGlobals());

  it('shows nothing of the claim it left while the next one loads, or when that read fails', async () => {
    const page = await pollPage({ [A]: claimA, [B]: 503 });
    page.render(A);
    await settle();
    expect(page.render(A).data?.claimId).toBe('A');
    const moved = page.render(B);
    expect(moved.data).toBeNull();
    expect(moved.loading).toBe(true);
    await settle();
    const failed = page.render(B);
    expect(failed.error?.status).toBe(503);
    expect(failed.data).toBeNull();
    page.leave();
  });

  it('a read of the claim it left that lands after the move is dropped', async () => {
    let land!: (body: unknown) => void;
    const page = await pollPage({ [A]: new Promise((r) => (land = r)), [B]: new Promise(() => {}) });
    page.render(A);
    page.render(B);
    land(claimA);
    await settle();
    expect(page.render(B).data).toBeNull();
    page.leave();
  });

  it('keeps the last good data of the same claim when a later read of it fails', async () => {
    const answers: Record<string, unknown> = { [A]: claimA };
    const page = await pollPage(answers);
    page.render(A, 1);
    await settle();
    answers[A] = 503;
    await settle(20);
    const s = page.render(A, 1);
    expect(s.data?.claimId).toBe('A');
    expect(s.error?.status).toBe(503);
    page.leave();
  });

  it('a path of null reads nothing and shows nothing', async () => {
    const page = await pollPage({ [A]: claimA });
    page.render(A);
    await settle();
    expect(page.render(null)).toEqual({ data: null, error: null, loading: false });
    page.leave();
  });
});
