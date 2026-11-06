import { cidOfHash } from '@recourse/records';
import { addressBook, canonicalBytes, claimIdOf, encodeClaimToCourt, externalIdUint, orderIdOf, recordHash, type CanonicalValue } from '@recourse/shared';
import { decodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { looksBuilt, signingProblems, type BuiltAction, type IntendedCall } from '../../agent/src/status-api.js';
import { CLAIMS_ABI, EVIDENCE_ABI, TOKEN_ABI, VAULT_ABI, type ContractLabel } from '../src/abi/deployed.js';
import { createApp } from '../src/app.js';
import { FILE_CLAIM_BUDGET } from '../src/v1/build.js';
import type { Config } from '../src/config.js';
import type { FetchLike } from '../src/http.js';
import { Store } from '../src/store.js';
import type { HcsRecord } from '../src/types.js';
import { ARB_GAS_PRICE, HEDERA_GAS_PRICE, TOKEN, caseNow, chainClaim, fakeChain, revertOf, type FakeState } from './helpers/chain.js';
import { Sim } from './helpers/encode.js';
import { CASE, CLAIMS, PLATFORM, SHOP, SHOP2, TOPIC, VAULT, buildClaim, h32, ingest, nonce, refsFor, type Built, type Stage } from './helpers/fixtures.js';
import { OPENAPI, check, responseSchema } from './helpers/schema.js';
import { harness } from './helpers/service.js';

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

interface Rig {
  b: Built;
  store: Store;
  chain: ReturnType<typeof fakeChain>;
  post: (name: string, body: unknown) => Promise<Reply>;
  url: string;
}

async function rig(opts: { stage?: Stage; chain?: Partial<FakeState>; cfg?: Partial<Config>; fetch?: FetchLike; extra?: (sim: Sim, b: Built) => void; store?: Store; now?: bigint } = {}): Promise<Rig> {
  const sim = new Sim();
  const b = buildClaim(sim, opts.stage ?? 'finding_made', 1);
  opts.extra?.(sim, b);
  const store = opts.store ?? new Store();
  ingest(store, sim);
  const now = opts.now ?? b.now;
  for (const s of ['hedera', 'arbitrum', 'hcs'] as const) store.status[s].indexedThrough = Number(now);
  const h = harness({ store, now: Number(now), deployments: { arbitrumChainId: ARB_ID }, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.cfg ? { cfg: opts.cfg } : {}) });
  const chain = fakeChain({ now, ...opts.chain });
  const app = createApp(h.svc, { chain });
  const url = await new Promise<string>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      closers.push(() => server.close());
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
  const post = async (name: string, body: unknown): Promise<Reply> => {
    const r = await fetch(`${url}/v1/actions/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  return { b, store, chain, post, url };
}

/** The answer conforms to the contract: the action's 200 schema, or the error schema. */
function conforms(name: string, r: Reply): void {
  const schema = r.status === 200 ? responseSchema(`/v1/actions/${name}`, 'post') : { $ref: '#/components/schemas/Error' };
  expect(check(schema, r.body), JSON.stringify(r.body).slice(0, 400)).toEqual([]);
}

function expectError(name: string, r: Reply, status: number, code: string): any {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error.code).toBe(code);
  conforms(name, r);
  return r.body.error;
}

const SEQ_SECONDS = 1_700_000_030n; // preCheckedAt in buildClaim
/** The contract lists the two testnets only; the harness runs as Arbitrum Sepolia. */
const ARB_ID = 421_614;

describe('contest', () => {
  const claim = (b: Built, over = {}) => chainClaim({ orderId: b.orderId, status: 2, answer: 1, preCheckedAt: SEQ_SECONDS, ...over });

  it('builds contest(claimId) for the platform, simulated as it, with the margin and the window end', async () => {
    const r0 = await rig({ chain: {} });
    r0.chain.state.claim = claim(r0.b);
    const r = await r0.post('contest', { from: PLATFORM.toLowerCase(), claimId: r0.b.claimId.toUpperCase().replace('0X', '0x') });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    conforms('contest', r);
    const a = r.body;
    expect(a).toMatchObject({ action: 'contest', chain: 'hedera', chainId: 296, from: PLATFORM, claimId: r0.b.claimId, simulated: true, readBack: `/v1/claims/${r0.b.claimId}` });
    expect(a.transactions).toHaveLength(1);
    const tx = a.transactions[0];
    expect(tx).toMatchObject({ chainId: 296, to: CLAIMS, value: '0', gas: '130000', gasPrice: HEDERA_GAS_PRICE.toString(), simulated: true, call: { contract: 'RecourseClaims', function: 'contest', args: { claimId: r0.b.claimId } } });
    expect(decodeFunctionData({ abi: CLAIMS_ABI, data: tx.data })).toMatchObject({ functionName: 'contest', args: [r0.b.claimId] });
    expect(a.notAfter).toBe((SEQ_SECONDS + 600n).toString());
    expect(a.preview.statusAfter).toBe('contested');
    expect(a.preview.amounts).toEqual([{ name: 'courtFee', amount: '3000000', decimals: 6, symbol: 'USDC', display: '3.00 USDC', movement: 'info', account: SHOP }]);
    expect(a.preview.fee).toMatchObject({ gas: '130000', amount: (130000n * HEDERA_GAS_PRICE).toString(), symbol: 'HBAR', decimals: 18, basis: 'estimate' });
    expect(a.input).toMatchObject({ claimId: r0.b.claimId, status: 2, statusName: 'PreChecked' });
    expect(r0.chain.sims[0]!.tx.from).toBe(PLATFORM);
  });

  it('uses the claim\'s own contest window, not the current one', async () => {
    const r0 = await rig({ chain: { terms: { contestWindow: 1800n, claimTimeout: 14_400n, handling: 1n } }, now: SEQ_SECONDS + 1000n });
    r0.chain.state.claim = claim(r0.b);
    const r = await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId });
    expect(r.status).toBe(200);
    expect(r.body.notAfter).toBe((SEQ_SECONDS + 1800n).toString());
    expect(r.body.preview.notes.join(' ')).not.toMatch(/keeps no terms per claim/);
    expect(r0.chain.calls).not.toContain('claimsNow');
  });

  it('on a claims contract without claimTermsOf, its params() window stands in, with a note saying so', async () => {
    // The deployed pair predates per-claim terms: claimTermsOf reverts, and the contract checks params().
    const r0 = await rig({ chain: { terms: null }, now: SEQ_SECONDS + 1000n });
    r0.chain.state.claimsNow = { ...r0.chain.state.claimsNow, contestWindow: 1800n };
    r0.chain.state.claim = claim(r0.b);
    const r = await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    conforms('contest', r);
    expect(r.body.notAfter).toBe((SEQ_SECONDS + 1800n).toString());
    expect(r.body.preview.notes.join(' ')).toMatch(/keeps no terms per claim/);
    r0.chain.state.claimsNow = { ...r0.chain.state.claimsNow, contestWindow: 600n };
    expect(expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 409, 'window_closed').details).toEqual({ closesAt: (SEQ_SECONDS + 600n).toString() });
    r0.chain.state.claim = claim(r0.b, { status: 6 });
    expect(expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 409, 'wrong_status').details.statusName).toBe('Settled');
  });

  it('a claimTermsOf the relay cannot answer is upstream_unavailable, never the params() window', async () => {
    const r0 = await rig({ chain: { down: new Set(['claimTerms']) } });
    r0.chain.state.claim = claim(r0.b);
    expect(expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 503, 'upstream_unavailable').details).toEqual({ upstream: 'hedera_rpc' });
    expect(r0.chain.calls).not.toContain('claimsNow');
    expect(r0.chain.sims).toHaveLength(0);
  });

  it('answers 403 not_contester for the side the finding went for, naming the contester', async () => {
    const r0 = await rig();
    r0.chain.state.claim = claim(r0.b);
    const e = expectError('contest', await r0.post('contest', { from: SHOP, claimId: r0.b.claimId }), 403, 'not_contester');
    expect(e.details.contester).toBe(PLATFORM);
    expect(r0.chain.sims).toHaveLength(0);
  });

  it('answers wrong_status, window_closed and not_found from the chain read', async () => {
    const r0 = await rig({ now: SEQ_SECONDS + 601n });
    r0.chain.state.claim = claim(r0.b, { status: 1 });
    expect(expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 409, 'wrong_status').details).toEqual({ status: 1, statusName: 'Filed' });
    r0.chain.state.claim = claim(r0.b);
    expect(expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 409, 'window_closed').details).toEqual({ closesAt: (SEQ_SECONDS + 600n).toString() });
    r0.chain.state.claim = null;
    expect(expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: h32(0xdead) }), 404, 'not_found').details).toMatchObject({ resource: 'claim', id: h32(0xdead) });
  });

  it('maps a revert found by simulation to its code, with the revert itself', async () => {
    const r0 = await rig({ chain: { rule: () => revertOf('RecourseClaims', 'WindowClosed', [SEQ_SECONDS + 600n]) } });
    r0.chain.state.claim = claim(r0.b);
    const e = expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 409, 'window_closed');
    expect(e.details).toEqual({ closesAt: (SEQ_SECONDS + 600n).toString(), revert: { contract: 'RecourseClaims', name: 'WindowClosed', args: [(SEQ_SECONDS + 600n).toString()] } });
  });

  it('answers call_reverted for an unlisted error and for a revert with no reason', async () => {
    const r0 = await rig({ chain: { rule: () => revertOf('RecourseClaims', 'OwnableUnauthorizedAccount', [SHOP]) } });
    r0.chain.state.claim = claim(r0.b);
    const e = expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 409, 'call_reverted');
    expect(e.details.revert).toEqual({ contract: 'RecourseClaims', name: 'OwnableUnauthorizedAccount', args: [SHOP] });
    r0.chain.state.rule = () => ({ ok: false, data: null });
    expect(expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 409, 'call_reverted').details.revert).toEqual({ contract: 'RecourseClaims', name: 'reverted', args: [] });
  });

  it('answers 503 upstream_unavailable when the relay does not answer', async () => {
    const r0 = await rig({ chain: { down: new Set(['claim']) } });
    expect(expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 503, 'upstream_unavailable').details).toEqual({ upstream: 'hedera_rpc' });
  });
});

describe('closeUncontested, settle and expireClaim', () => {
  it('closeUncontested: window_open until the window ends, then toShop and the fee refund from previewSettle', async () => {
    const r0 = await rig({ stage: 'window_lapsed', now: SEQ_SECONDS + 600n });
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 2, preCheckedAt: SEQ_SECONDS });
    expect(expectError('closeUncontested', await r0.post('closeUncontested', { from: SHOP2, claimId: r0.b.claimId }), 409, 'window_open').details).toEqual({ closesAt: (SEQ_SECONDS + 600n).toString() });
    r0.chain.state.now = SEQ_SECONDS + 601n;
    r0.chain.state.settle = { toShop: 68_000_000n, refund: 3_000_000n, toPool: 0n };
    const r = await r0.post('closeUncontested', { from: SHOP2, claimId: r0.b.claimId });
    expect(r.status).toBe(200);
    conforms('closeUncontested', r);
    expect(r.body.preview.amounts.map((a: any) => [a.name, a.amount, a.movement, a.account])).toEqual([
      ['toShop', '68000000', 'credit', SHOP],
      ['feeRefund', '3000000', 'credit', SHOP],
    ]);
    expect(r.body.preview.statusAfter).toBe('closed_uncontested');
  });

  it('settle: only a ruled claim; toShop credit and toPool info', async () => {
    const r0 = await rig({ stage: 'ruled' });
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 4 });
    expect(expectError('settle', await r0.post('settle', { from: SHOP, claimId: r0.b.claimId }), 409, 'wrong_status').details.statusName).toBe('AtCourt');
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 5 });
    r0.chain.state.settle = { toShop: 71_000_000n, refund: 0n, toPool: 3_000_000n };
    const r = await r0.post('settle', { from: SHOP, claimId: r0.b.claimId });
    expect(r.status).toBe(200);
    conforms('settle', r);
    expect(r.body.preview.amounts.map((a: any) => [a.name, a.amount, a.movement])).toEqual([
      ['toShop', '71000000', 'credit'],
      ['toPool', '3000000', 'info'],
    ]);
  });

  it('expireClaim: not_expired until the claim\'s own timeout has passed, then the fee refund', async () => {
    const filedAt = 1_700_000_000n;
    const r0 = await rig({ stage: 'filed', now: filedAt + 14_400n, chain: { escrow: 3_000_000n } });
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 1, filedAt });
    expect(expectError('expireClaim', await r0.post('expireClaim', { from: SHOP, claimId: r0.b.claimId }), 409, 'not_expired').details).toEqual({ expiresAfter: (filedAt + 14_400n).toString() });
    r0.chain.state.now = filedAt + 14_401n;
    const r = await r0.post('expireClaim', { from: SHOP, claimId: r0.b.claimId });
    expect(r.status).toBe(200);
    conforms('expireClaim', r);
    expect(r.body.preview.amounts[0]).toMatchObject({ name: 'feeRefund', amount: '3000000', movement: 'credit', account: SHOP });
    expect(r.body.preview.changes.join(' ')).toMatch(/reserved for this claim is released/);
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 2 });
    expect(expectError('expireClaim', await r0.post('expireClaim', { from: SHOP, claimId: r0.b.claimId }), 409, 'wrong_status').details.statusName).toBe('PreChecked');
  });

  it('closeUncontested and expireClaim on a claims contract without claimTermsOf count from its params(), and release no reservation on an older vault', async () => {
    const r0 = await rig({ stage: 'window_lapsed', now: SEQ_SECONDS + 601n, chain: { terms: null, reserves: false } });
    r0.chain.state.claimsNow = { ...r0.chain.state.claimsNow, contestWindow: 1800n, claimTimeout: 64_800n };
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 2, preCheckedAt: SEQ_SECONDS });
    expect(expectError('closeUncontested', await r0.post('closeUncontested', { from: SHOP2, claimId: r0.b.claimId }), 409, 'window_open').details).toEqual({ closesAt: (SEQ_SECONDS + 1800n).toString() });
    r0.chain.state.now = SEQ_SECONDS + 1801n;
    const close = await r0.post('closeUncontested', { from: SHOP2, claimId: r0.b.claimId });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    conforms('closeUncontested', close);
    expect(close.body.preview.notes.join(' ')).toMatch(/keeps no terms per claim/);

    const filedAt = 1_700_000_000n;
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 1, filedAt });
    r0.chain.state.now = filedAt + 64_800n;
    expect(expectError('expireClaim', await r0.post('expireClaim', { from: SHOP, claimId: r0.b.claimId }), 409, 'not_expired').details).toEqual({ expiresAfter: (filedAt + 64_800n).toString() });
    r0.chain.state.now = filedAt + 64_801n;
    const exp = await r0.post('expireClaim', { from: SHOP, claimId: r0.b.claimId });
    expect(exp.status, JSON.stringify(exp.body)).toBe(200);
    conforms('expireClaim', exp);
    expect(exp.body.preview.notes.join(' ')).toMatch(/keeps no terms per claim/);
    expect(exp.body.preview.changes.join(' ')).not.toMatch(/reserved/);
  });

  it('expireClaim warns when a ruling is on its way back', async () => {
    const r0 = await rig({ stage: 'ruled', now: 1_800_000_000n });
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 4, preCheckedAt: SEQ_SECONDS });
    r0.store.live.set(r0.b.claimId, { caseView: { ...(r0.b.live!.caseView!), state: 5 }, exec: {}, kleros: {}, at: 0 });
    const r = await r0.post('expireClaim', { from: SHOP, claimId: r0.b.claimId });
    expect(r.status).toBe(200);
    expect(r.body.preview.notes.join(' ')).toMatch(/ruling is on its way back/);
  });
});

describe('sendToCourt and resend', () => {
  it('sendToCourt: the CCIP fee in the fee token, paid by the claims contract; LinkShort answers contract_underfunded', async () => {
    const r0 = await rig({ stage: 'contested' });
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 3 });
    const r = await r0.post('sendToCourt', { from: SHOP2, claimId: r0.b.claimId });
    expect(r.status).toBe(200);
    conforms('sendToCourt', r);
    expect(r.body.preview.amounts[0]).toMatchObject({ name: 'ccipFee', amount: '2000000000000000', symbol: 'LINK', decimals: 18, movement: 'contract_pays', account: CLAIMS });
    expect(r.body.preview.statusAfter).toBe('at_court');
    r0.chain.state.rule = () => revertOf('RecourseClaims', 'LinkShort', [1n, 2_000_000_000_000_000n]);
    const e = expectError('sendToCourt', await r0.post('sendToCourt', { from: SHOP2, claimId: r0.b.claimId }), 409, 'contract_underfunded');
    expect(e.details).toMatchObject({ have: '1', need: '2000000000000000', asset: 'LINK' });
  });

  it('sendToCourt: wrong_status before contest, bridge_unavailable without a peer', async () => {
    const r0 = await rig({ stage: 'contested' });
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 2 });
    expectError('sendToCourt', await r0.post('sendToCourt', { from: SHOP, claimId: r0.b.claimId }), 409, 'wrong_status');
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 3 });
    r0.chain.state.claimsNow = { ...r0.chain.state.claimsNow, peer: '0x0000000000000000000000000000000000000000' };
    expectError('sendToCourt', await r0.post('sendToCourt', { from: SHOP, claimId: r0.b.claimId }), 409, 'bridge_unavailable');
  });

  it('resend: resend_too_soon, max_sends_reached, and bridge_unavailable in mode None', async () => {
    const r0 = await rig({ stage: 'at_court', now: 1_700_010_000n });
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 4, sendCount: 1, lastSendAt: 1_700_009_000n });
    expect(expectError('resend', await r0.post('resend', { from: SHOP, claimId: r0.b.claimId }), 409, 'resend_too_soon').details).toEqual({ availableAt: '1700010800' });
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 4, sendCount: 5, lastSendAt: 1_700_000_000n });
    expectError('resend', await r0.post('resend', { from: SHOP, claimId: r0.b.claimId }), 409, 'max_sends_reached');
    r0.chain.state.claimsNow = { ...r0.chain.state.claimsNow, bridgeMode: 2 };
    expect(expectError('resend', await r0.post('resend', { from: SHOP, claimId: r0.b.claimId }), 409, 'bridge_unavailable').details).toEqual({ mode: 2 });
    r0.chain.state.claimsNow = { ...r0.chain.state.claimsNow, bridgeMode: 0 };
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 4, sendCount: 1, lastSendAt: 1_700_000_000n });
    const r = await r0.post('resend', { from: SHOP, claimId: r0.b.claimId });
    expect(r.status).toBe(200);
    conforms('resend', r);
  });
});

describe('withdrawCredit', () => {
  it('pays the whole credit; no_credit at 0; NotAssociated answers not_associated', async () => {
    const r0 = await rig();
    expectError('withdrawCredit', await r0.post('withdrawCredit', { from: SHOP }), 409, 'no_credit');
    r0.chain.state.credit = 68_000_000n;
    const r = await r0.post('withdrawCredit', { from: SHOP });
    expect(r.status).toBe(200);
    conforms('withdrawCredit', r);
    expect(r.body).toMatchObject({ claimId: null, readBack: `/v1/parties/${SHOP}`, input: { account: SHOP, credit: '68000000' } });
    expect(r.body.transactions[0]).toMatchObject({ to: VAULT, call: { contract: 'DepositVault', function: 'withdrawCredit', args: {} } });
    expect(r.body.preview.amounts[0]).toMatchObject({ name: 'credit', movement: 'receive', account: SHOP });
    r0.chain.state.rule = () => revertOf('DepositVault', 'NotAssociated', [SHOP]);
    expect(expectError('withdrawCredit', await r0.post('withdrawCredit', { from: SHOP }), 409, 'not_associated').details).toMatchObject({ account: SHOP, revert: { contract: 'DepositVault', name: 'NotAssociated' } });
  });
});

describe('submitEvidence', () => {
  it('builds EvidenceModule.submitEvidence with the external id of the current attempt and the JSON text', async () => {
    const r0 = await rig({ stage: 'at_court', chain: { period: 0 } });
    r0.chain.state.kase = caseNow({ state: 2, attempts: 1, disputeIds: [901n, 0n] });
    const r = await r0.post('submitEvidence', { from: SHOP, claimId: r0.b.claimId, name: 'Delivery photo', description: 'The parcel as it **arrived**.', fileURI: '/ipfs/bafkreiexample' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    conforms('submitEvidence', r);
    const ext = externalIdUint(ARB_ID, CASE, r0.b.claimId, 1);
    const tx = r.body.transactions[0];
    expect(tx.chainId).toBe(ARB_ID);
    expect(tx.gasPrice).toBe(ARB_GAS_PRICE.toString());
    const d = decodeFunctionData({ abi: EVIDENCE_ABI, data: tx.data });
    const text = JSON.stringify({ name: 'Delivery photo', description: 'The parcel as it **arrived**.', fileURI: '/ipfs/bafkreiexample' });
    expect(d.args).toEqual([ext, text]);
    expect(tx.gas).toBe('120000');
    expect(r.body.input).toMatchObject({ attempt: 1, disputeId: '901', externalId: ext.toString(), evidence: text, byteLength: text.length, periodName: 'evidence' });
    expect(r.body.preview.amounts).toEqual([]);
  });

  it('answers no_dispute, evidence_too_large, not_found and invalid_field', async () => {
    const r0 = await rig({ stage: 'at_court' });
    r0.chain.state.kase = caseNow({ state: 1 });
    expectError('submitEvidence', await r0.post('submitEvidence', { from: SHOP, claimId: r0.b.claimId, name: 'n', description: 'd' }), 409, 'no_dispute');
    const big = await r0.post('submitEvidence', { from: SHOP, claimId: r0.b.claimId, name: 'n', description: 'é'.repeat(25_000) });
    expect(expectError('submitEvidence', big, 422, 'evidence_too_large').details).toMatchObject({ max: 49152 });
    r0.chain.state.kase = null;
    expect(expectError('submitEvidence', await r0.post('submitEvidence', { from: SHOP, claimId: r0.b.claimId, name: 'n', description: 'd' }), 404, 'not_found').details.resource).toBe('case');
    expect(expectError('submitEvidence', await r0.post('submitEvidence', { from: SHOP, claimId: r0.b.claimId, name: 'n', description: 'd', fileURI: 'http://plain.example/x' }), 400, 'invalid_field').details.field).toBe('fileURI');
    expect(expectError('submitEvidence', await r0.post('submitEvidence', { from: SHOP, claimId: r0.b.claimId, name: 'n', description: 'd', attempt: 3 }), 400, 'invalid_field').details.field).toBe('attempt');
  });
});

describe('openCase, refile and relayRuling', () => {
  function payloadFor(b: Built): Hex {
    return encodeClaimToCourt({
      version: 1, claimId: b.claimId, platform: PLATFORM, shop: SHOP, gap: 1, answer: 1, refs: refsFor() as never, packHash: h32(0x9a01),
      basketUsdc: 60_000_000n, netLossUsdc: 50_000_000n, filedAt: 1_700_000_000n,
    });
  }
  async function received(chain: Partial<FakeState> = {}) {
    let payload: Hex = '0x';
    const r0 = await rig({
      stage: 'contested',
      chain,
      extra: (sim, b) => {
        payload = payloadFor(b);
        sim.tick(20).hedera('claims', 'SentToCourt', { claimId: b.claimId, messageId: b.sendMsg });
        sim.tick(40).arb('ClaimReceived', { claimId: b.claimId, messageId: b.sendMsg, payload });
      },
    });
    r0.chain.state.kase = caseNow({ state: 1, payloadHash: keccak256(payload), expiresAt: r0.chain.state.now + 50_000n });
    return { ...r0, payload };
  }

  it('openCase: the payload from the indexed ClaimReceived event, the dispute cost from the fee pool, the keeper floor on gas', async () => {
    const r0 = await received();
    const r = await r0.post('openCase', { from: SHOP2, claimId: r0.b.claimId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    conforms('openCase', r);
    const tx = r.body.transactions[0];
    expect(tx).toMatchObject({ to: CASE, gas: '1300000', call: { contract: 'RecourseCase', function: 'openCase', args: { payload: r0.payload } } });
    expect(r.body.preview.amounts[0]).toMatchObject({ name: 'disputeCost', amount: '50000000000000', symbol: 'ETH', movement: 'contract_pays', account: CASE });
    expect(r.body.input).toMatchObject({ caseState: 'received' });
  });

  it('openCase: case_wrong_state, cap_reached, contract_underfunded, and the stale path', async () => {
    const r0 = await received();
    const k = r0.chain.state.kase!;
    r0.chain.state.kase = { ...k, state: 2 };
    expect(expectError('openCase', await r0.post('openCase', { from: SHOP, claimId: r0.b.claimId }), 409, 'case_wrong_state').details).toEqual({ state: 2, stateName: 'opened' });
    r0.chain.state.kase = k;
    r0.chain.state.court = { ...r0.chain.state.court, openCases: 10 };
    expectError('openCase', await r0.post('openCase', { from: SHOP, claimId: r0.b.claimId }), 409, 'cap_reached');
    r0.chain.state.court = { ...r0.chain.state.court, openCases: 0, feePool: 1n };
    expect(expectError('openCase', await r0.post('openCase', { from: SHOP, claimId: r0.b.claimId }), 409, 'contract_underfunded').details).toEqual({ have: '1', need: '50000000000000', asset: 'ETH' });
    r0.chain.state.kase = { ...k, expiresAt: r0.chain.state.now + 100n };
    const stale = await r0.post('openCase', { from: SHOP, claimId: r0.b.claimId });
    expect(stale.status).toBe(200);
    expect(stale.body.preview.amounts).toEqual([]);
    expect(stale.body.preview.notes[0]).toMatch(/marks the case stale/);
  });

  it('openCase: upstream_unavailable (index) when the payload is not indexed yet; not_found without a case', async () => {
    const r0 = await rig({ stage: 'contested' });
    r0.chain.state.kase = caseNow({ state: 1, payloadHash: h32(0x77) });
    expect(expectError('openCase', await r0.post('openCase', { from: SHOP, claimId: r0.b.claimId }), 503, 'upstream_unavailable').details.upstream).toBe('index');
    r0.chain.state.kase = null;
    expectError('openCase', await r0.post('openCase', { from: SHOP, claimId: r0.b.claimId }), 404, 'not_found');
  });

  it('refile: only RefilePending on attempt 1', async () => {
    const r0 = await received();
    r0.chain.state.kase = { ...r0.chain.state.kase!, state: 3, attempts: 2 };
    expectError('refile', await r0.post('refile', { from: SHOP, claimId: r0.b.claimId }), 409, 'case_wrong_state');
    r0.chain.state.kase = { ...r0.chain.state.kase!, attempts: 1 };
    const r = await r0.post('refile', { from: SHOP, claimId: r0.b.claimId });
    expect(r.status).toBe(200);
    conforms('refile', r);
  });

  it('relayRuling: native pays exactly the quote as value; link pays from the contract; resend_too_soon and insufficient_value', async () => {
    const r0 = await rig({ stage: 'ruled', now: 1_700_010_000n });
    r0.chain.state.kase = caseNow({ state: 4, attempts: 1, disputeIds: [901n, 0n], ruling: 1 });
    const n = await r0.post('relayRuling', { from: SHOP, claimId: r0.b.claimId });
    expect(n.status).toBe(200);
    conforms('relayRuling', n);
    expect(n.body.transactions[0]).toMatchObject({ value: '30000000000000', gas: '450000' });
    expect(r0.chain.sims.at(-1)!.tx.value).toBe(30_000_000_000_000n);
    expect(n.body.preview.amounts[0]).toMatchObject({ name: 'ccipFee', symbol: 'ETH', movement: 'send', account: SHOP });
    const l = await r0.post('relayRuling', { from: SHOP, claimId: r0.b.claimId, payIn: 'link' });
    expect(l.body.transactions[0].value).toBe('0');
    expect(l.body.preview.amounts[0]).toMatchObject({ symbol: 'LINK', movement: 'contract_pays', account: CASE });
    r0.chain.state.kase = caseNow({ state: 5, sendCount: 1, lastSendAt: 1_700_009_500n });
    expect(expectError('relayRuling', await r0.post('relayRuling', { from: SHOP, claimId: r0.b.claimId }), 409, 'resend_too_soon').details).toEqual({ availableAt: '1700011300' });
    r0.chain.state.kase = caseNow({ state: 5, sendCount: 1, lastSendAt: 1_700_000_000n });
    r0.chain.state.rule = () => revertOf('RecourseCase', 'InsufficientValue', [1n, 2n]);
    expect(expectError('relayRuling', await r0.post('relayRuling', { from: SHOP, claimId: r0.b.claimId }), 409, 'insufficient_value').details).toMatchObject({ sent: '1', need: '2' });
    r0.chain.state.kase = caseNow({ state: 2 });
    expectError('relayRuling', await r0.post('relayRuling', { from: SHOP, claimId: r0.b.claimId }), 409, 'case_wrong_state');
    expectError('relayRuling', await r0.post('relayRuling', { from: SHOP, claimId: r0.b.claimId, payIn: 'card' }), 400, 'invalid_field');
  });

  it('relayRuling builds no re-relay once the claim is settled, closed or expired on Hedera, and nextAction never offers one', async () => {
    for (const [status, statusName] of [[6, 'Settled'], [7, 'Closed'], [8, 'Expired']] as const) {
      const r0 = await rig({ stage: 'settled', now: 1_700_010_000n });
      // The case on Arbitrum stays relayed, with the resend gap long past.
      r0.chain.state.kase = caseNow({ state: 5, attempts: 1, disputeIds: [901n, 0n], ruling: 1, sendCount: 1, lastSendAt: 1_700_000_000n });
      r0.chain.state.claim = chainClaim({ status });
      const e = expectError('relayRuling', await r0.post('relayRuling', { from: SHOP, claimId: r0.b.claimId }), 409, 'wrong_status');
      expect(e.details).toEqual({ status, statusName });
      expect(r0.chain.sims).toHaveLength(0);
      const claim = (await (await fetch(`${r0.url}/v1/claims/${r0.b.claimId}`)).json()) as any;
      expect(claim.claim.nextAction?.action).not.toBe('relayRuling');
    }
  });
});

// ------------------------------------------------------------------ fileClaim

const PLATFORM_WRITER = '0.0.1002';
const SHOP_WRITER = '0.0.2001';
const N = nonce(7);
const ORDER = orderIdOf(PLATFORM, SHOP, N).toLowerCase() as Hex;
const CLAIM = claimIdOf(296, CLAIMS, ORDER).toLowerCase() as Hex;
const PAY_TX = '0.0.1002@1700000000.000000001';

interface Topic {
  store: Store;
  fetch: FetchLike;
  hashes: Hex[];
}

/** Records for ORDER on the topic: per kind one from its own writer, plus strangers' earlier copies. */
function topic(opts: { skip?: number[]; ordered?: Record<string, string> } = {}): Topic {
  const store = new Store();
  const gateway = new Map<string, Uint8Array>();
  const attrs = { brand: 'Sample', size: 'M', price: '25' };
  const docs: Record<string, CanonicalValue>[] = [
    { v: '1', kind: 'asked', orderId: ORDER, attrs },
    { v: '1', kind: 'shown', orderId: ORDER, attrs, changes: [] },
    { v: '1', kind: 'approval', orderId: ORDER, approval: 'approved' },
    { v: '1', kind: 'ordered', orderId: ORDER, attrs: { ...attrs, price: '30' }, x402TxId: PAY_TX, amount: '2500000000', asset: '0.0.0', payTo: '0.0.2001', ...opts.ordered },
    { v: '1', kind: 'packed', orderId: ORDER, attrs: { ...attrs, price: '30' } },
    { v: '1', kind: 'arrived', orderId: ORDER, attrs: { ...attrs, price: '30' } },
  ];
  const recs: HcsRecord[] = [];
  const hashes: Hex[] = [];
  docs.forEach((doc, k) => {
    const bytes = canonicalBytes(doc);
    const hash = recordHash(bytes);
    const cid = cidOfHash(hash).toString();
    gateway.set(cid, bytes);
    hashes.push(hash);
    if (opts.skip?.includes(k)) return;
    recs.push({ topic: TOPIC, seq: 10 + k, consensusTimestamp: `1700000000.00000001${k}`, payer: k === 4 ? SHOP_WRITER : PLATFORM_WRITER, kind: k, orderId: ORDER, hash, cid });
  });
  // Earlier copies from another shop's writer and from a stranger: never counted.
  recs.push({ topic: TOPIC, seq: 2, consensusTimestamp: '1700000000.000000002', payer: '0.0.2002', kind: 4, orderId: ORDER, hash: h32(0x4444), cid: 'bafkreistranger' });
  recs.push({ topic: TOPIC, seq: 3, consensusTimestamp: '1700000000.000000003', payer: '0.0.9999', kind: 3, orderId: ORDER, hash: h32(0x3333), cid: 'bafkreistranger2' });
  store.addHcs(recs);
  const fetch: FetchLike = async (url) => {
    if (url.startsWith('http://gateway.test/ipfs/')) {
      const bytes = gateway.get(url.split('/ipfs/')[1]!.split('?')[0]!);
      if (bytes) return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    }
    if (url.startsWith('http://127.0.0.1:8720/orders/')) {
      const id = url.split('/orders/')[1];
      if (id === ORDER) return { ok: true, status: 200, json: async () => ({ order: { orderId: ORDER, orderNonce: N, platform: PLATFORM.toLowerCase(), status: 'packed', payment: { txId: PAY_TX } }, inFlight: false }), arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: false, status: 404, json: async () => ({ error: 'order_not_found' }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { store, fetch, hashes };
}

async function filing(opts: { topic?: Parameters<typeof topic>[0]; chain?: Partial<FakeState>; fetch?: FetchLike } = {}) {
  const t = topic(opts.topic);
  const r0 = await rig({ store: t.store, fetch: opts.fetch ?? t.fetch, chain: opts.chain, now: 1_700_000_100n, extra: () => undefined });
  return { ...r0, t };
}

describe('fileClaim', () => {
  it('derives the order, claim, refs (own writers only) and basket; approve first when the allowance is short', async () => {
    const r0 = await filing();
    const r = await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, netLossUsdc: '20000000' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    conforms('fileClaim', r);
    const a = r.body;
    expect(a).toMatchObject({ action: 'fileClaim', claimId: CLAIM, simulated: false, readBack: `/v1/claims/${CLAIM}` });
    expect(a.transactions).toHaveLength(2);
    const [approve, file] = a.transactions;
    expect(approve).toMatchObject({ to: TOKEN, simulated: true, call: { contract: 'VaultToken', function: 'approve', args: { spender: VAULT, amount: '3000000' } } });
    expect(decodeFunctionData({ abi: TOKEN_ABI, data: approve.data }).args).toEqual([VAULT, 3_000_000n]);
    expect(file).toMatchObject({ to: CLAIMS, simulated: false, gas: FILE_CLAIM_BUDGET.toString() });
    const d = decodeFunctionData({ abi: CLAIMS_ABI, data: file.data });
    expect(d.functionName).toBe('fileClaim');
    const [n, p, refs, basket, netLoss] = d.args as [Hex, Address, { topicNum: bigint; seq: readonly bigint[]; hashes: readonly Hex[] }, bigint, bigint];
    expect([n, p, basket, netLoss]).toEqual([N, PLATFORM, 25_000_000n, 20_000_000n]);
    expect(refs.topicNum).toBe(4000n);
    expect(refs.seq).toEqual([10n, 11n, 12n, 13n, 14n, 15n]);
    expect(refs.hashes).toEqual(r0.t.hashes);
    expect(a.input).toMatchObject({
      orderId: ORDER, orderNonce: N, platform: PLATFORM, shop: SHOP, claimId: CLAIM, basketUsdc: '25000000', netLossUsdc: '20000000', courtFeeUsdc: '3000000',
      handlingUsdc: '16250000', maxPayoutUsdc: (20_000_000n + 16_250_000n + 3_000_000n).toString(), approveNeeded: true, orderSource: 'request',
      expectedFinding: { gap: 2, answer: 1, side: 'platform', reasonKey: 'gap2_shown_vs_ordered', step: '3' },
    });
    expect(a.input.refs.seq).toEqual(['10', '11', '12', '13', '14', '15']);
    expect(a.preview.fee.basis).toBe('budget');
    expect(a.preview.fee.gas).toBe((130_000n + FILE_CLAIM_BUDGET).toString());
    expect(a.preview.amounts.map((x: any) => [x.name, x.movement, x.account])).toEqual([
      ['basket', 'info', null], ['netLoss', 'info', null], ['handling', 'info', null], ['courtFee', 'escrow', SHOP], ['maxPayout', 'reserve', PLATFORM],
    ]);
    expect(a.preview.notes[0]).toMatch(/only after approve has mined/);
    // only the approve was simulated, as the shop
    expect(r0.chain.sims.map((s) => [s.fn, s.tx.from])).toEqual([['approve', SHOP]]);
  });

  it('the unsimulated fileClaim budget covers what the deployed fileClaim used on Hedera, at the shop\'s x1.3 margin', () => {
    // Mirror node, the shop's last two fileClaims on the deployed pair: 559,974 and 559,986 gas used.
    // A limit below that ran out of gas after its approve had mined.
    expect(FILE_CLAIM_BUDGET).toBeGreaterThanOrEqual((559_986n * 13n) / 10n);
  });

  it('on a vault from before reservations, maxPayout is shown for information and nothing is said to be reserved', async () => {
    const r0 = await filing({ chain: { allowance: 3_000_000n, reserves: false } });
    const r = await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    conforms('fileClaim', r);
    expect(r.body.preview.amounts.find((x: any) => x.name === 'maxPayout')).toMatchObject({ amount: (25_000_000n + 16_250_000n + 3_000_000n).toString(), movement: 'info', account: null });
    const changes = r.body.preview.changes.join(' ');
    expect(changes).toMatch(/Nothing of the platform's deposit is reserved/);
    expect(changes).not.toMatch(/is reserved for this claim\./);
    expect(r.body.transactions[0].description).not.toMatch(/reserves/);
  });

  it('with enough allowance: fileClaim alone, simulated, basis estimate', async () => {
    const r0 = await filing({ chain: { allowance: 3_000_000n } });
    const r = await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N });
    expect(r.status).toBe(200);
    conforms('fileClaim', r);
    expect(r.body.transactions).toHaveLength(1);
    expect(r.body.transactions[0]).toMatchObject({ simulated: true, gas: '130000' });
    expect(r.body).toMatchObject({ simulated: true, preview: { fee: { basis: 'estimate' } }, input: { approveNeeded: false, netLossUsdc: '25000000' } });
  });

  it('a vault refusal found by simulation is the vault\'s error', async () => {
    const r0 = await filing({ chain: { allowance: 3_000_000n, rule: () => revertOf('DepositVault', 'ExitDue') } });
    const e = expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 409, 'exit_due');
    expect(e.details.revert).toEqual({ contract: 'DepositVault', name: 'ExitDue', args: [] });
    r0.chain.state.rule = () => revertOf('DepositVault', 'TransferFailed');
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 409, 'insufficient_balance').details).toMatchObject({ balance: '10000000', required: '3000000', revert: { contract: 'DepositVault', name: 'TransferFailed' } });
  });

  it('orderId alone asks the shop service for the nonce and platform', async () => {
    const r0 = await filing({ chain: { allowance: 3_000_000n } });
    const r = await r0.post('fileClaim', { from: SHOP, orderId: ORDER });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.input).toMatchObject({ orderSource: 'shop_service', orderNonce: N, platform: PLATFORM });
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, orderId: h32(0xbeef) }), 422, 'order_nonce_unknown');
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP2, orderId: ORDER }), 422, 'order_id_mismatch');
  });

  it('orderId alone: not_paid, ordered_tx_mismatch, and the shop unreachable', async () => {
    const base = topic();
    const shopSays = (order: Record<string, unknown> | null): FetchLike => async (url, init) => {
      if (url.startsWith('http://127.0.0.1:8720/orders/')) {
        if (order === null) return { ok: false, status: 502, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
        return { ok: true, status: 200, json: async () => ({ order: { orderNonce: N, platform: PLATFORM, ...order }, inFlight: false }), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return base.fetch(url, init);
    };
    let r0 = await filing({ fetch: shopSays({ status: 'payer_mismatch', payment: { txId: PAY_TX } }) });
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, orderId: ORDER }), 422, 'not_paid');
    r0 = await filing({ fetch: shopSays({ status: 'paid', payment: { txId: '0.0.1002@1700000999.000000001' } }) });
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, orderId: ORDER }), 422, 'ordered_tx_mismatch');
    r0 = await filing({ fetch: shopSays(null) });
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, orderId: ORDER }), 503, 'upstream_unavailable').details.upstream).toBe('shop');
  });

  it('refuses before building: records, basket and net loss', async () => {
    let r0 = await filing({ topic: { skip: [3] } });
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 422, 'no_ordered_record');
    r0 = await filing({ topic: { skip: [4] } });
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 422, 'no_packed_record');
    const anyway = await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, allowUnpacked: true });
    expect(anyway.status).toBe(200);
    expect(anyway.body.input.refs.seq[4]).toBe('0');
    r0 = await filing();
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, basketUsdc: '25000001' }), 422, 'basket_mismatch').details).toEqual({ derived: '25000000' });
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, netLossUsdc: '25000001' }), 422, 'net_loss_above_basket');
    expectError('fileClaim', await r0.post('fileClaim', { from: PLATFORM, platform: PLATFORM, orderNonce: N }), 422, 'same_party');
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, orderId: h32(1) }), 422, 'order_id_mismatch');
    r0 = await filing({ topic: { ordered: { amount: '0' } } });
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 422, 'zero_basket');
    r0 = await filing({ topic: { ordered: { asset: '0.0.123' } } });
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 422, 'ordered_unreadable');
  });

  it('refuses from the chain: claim_exists, vault_not_ready, exit_due, insufficient_balance', async () => {
    const r0 = await filing();
    r0.chain.state.claim = chainClaim({ status: 1 });
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 409, 'claim_exists').details).toEqual({ claimId: CLAIM });
    r0.chain.state.claim = null;
    r0.chain.state.gate = { exitRequestedAt: 0n, exitDelay: 600n, usdcAssociated: false };
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 409, 'vault_not_ready');
    r0.chain.state.gate = { exitRequestedAt: 1_700_000_100n - 600n, exitDelay: 600n, usdcAssociated: true };
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 409, 'exit_due');
    r0.chain.state.gate = { exitRequestedAt: 1_700_000_100n - 599n, exitDelay: 600n, usdcAssociated: true };
    r0.chain.state.balance = 2_999_999n;
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 409, 'insufficient_balance').details).toEqual({ balance: '2999999', required: '3000000' });
  });

  it('a topic that is behind answers upstream_unavailable (index), not no_ordered_record', async () => {
    const r0 = await filing({ topic: { skip: [3] } });
    r0.store.status.hcs.failing = true;
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 503, 'upstream_unavailable').details.upstream).toBe('index');
  });

  it('answers basket_too_large above the contract limit', async () => {
    const r0 = await filing({ topic: { ordered: { amount: (2n ** 128n * 100n).toString() } } });
    expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N }), 422, 'basket_too_large');
  });

  it('takes no field it does not list, and checks every field', async () => {
    const r0 = await filing();
    const e = expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, privateKey: '0x' + '11'.repeat(32) }), 400, 'unknown_field');
    expect(e.details).toEqual({ field: 'privateKey' });
    expect(JSON.stringify(e)).not.toContain('11'.repeat(32));
    expect(expectError('fileClaim', await r0.post('fileClaim', { platform: PLATFORM, orderNonce: N }), 400, 'missing_field').details.field).toBe('from');
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, orderNonce: N }), 400, 'missing_field').details.field).toBe('platform');
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP }), 400, 'missing_field').details.field).toBe('orderNonce');
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: '0x12', platform: PLATFORM, orderNonce: N }), 400, 'invalid_field').details.field).toBe('from');
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: '0x12' }), 400, 'invalid_field').details.field).toBe('orderNonce');
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, netLossUsdc: 5 }), 400, 'invalid_field').details.field).toBe('netLossUsdc');
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, netLossUsdc: '-1' }), 400, 'invalid_field').details.field).toBe('netLossUsdc');
    expect(expectError('fileClaim', await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, allowUnpacked: 'yes' }), 400, 'invalid_field').details.field).toBe('allowUnpacked');
    expect(r0.chain.calls).toEqual([]);
  });
});


// ------------------------------------------------------------------ the revert map, row by row

describe('every contract error in the revert map', () => {
  const MAP = (OPENAPI as any)['x-recourse-revert-map'] as { contract: ContractLabel | '*'; error: string; code: string; status: number; details: string[] }[];
  const argFor = (type: string): unknown => (type === 'address' ? SHOP : type === 'bytes32' ? CLAIM : type === 'uint8' ? 3 : 1_700_000_700n);

  for (const row of MAP.filter((r) => r.contract !== '*')) {
    it(`${row.contract}.${row.error} answers ${row.status} ${row.code} with ${row.details.join(', ')}`, async () => {
      const name = row.error.slice(0, row.error.indexOf('('));
      const types = row.error.slice(row.error.indexOf('(') + 1, -1).split(',').filter(Boolean);
      const rule = () => revertOf(row.contract as ContractLabel, name, types.map(argFor));
      let reply: Reply;
      let action: string;
      if (row.contract === 'DepositVault') {
        // raised inside fileClaim; simulated once the allowance covers the fee
        const r0 = await filing({ chain: { allowance: 3_000_000n, rule } });
        action = 'fileClaim';
        reply = await r0.post(action, { from: SHOP, platform: PLATFORM, orderNonce: N });
      } else if (row.contract === 'RecourseClaims') {
        const r0 = await rig({ chain: { rule } });
        r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 2, answer: 1, preCheckedAt: SEQ_SECONDS });
        action = 'contest';
        reply = await r0.post(action, { from: PLATFORM, claimId: r0.b.claimId });
      } else {
        const r0 = await rig({ stage: 'ruled', chain: { rule } });
        r0.chain.state.kase = caseNow({ state: 4, attempts: 1, disputeIds: [901n, 0n], ruling: 1 });
        action = 'relayRuling';
        reply = await r0.post(action, { from: SHOP, claimId: r0.b.claimId });
      }
      const e = expectError(action, reply, row.status, row.code);
      for (const k of row.details) expect(e.details, `${row.error}: ${k}`).toHaveProperty(k);
      expect(e.details.revert).toMatchObject({ contract: row.contract, name });
      expect(e.details.revert.args).toHaveLength(types.length);
      expect(e.message).not.toMatch(/0x[0-9a-f]{8}/i);
    });
  }

  it('an unexpected failure answers 500 internal, with no trace in the body', async () => {
    const r0 = await rig();
    r0.chain.claim = () => Promise.reject(new Error('boom at /home/someone/secret.ts:12'));
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const e = expectError('contest', await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId }), 500, 'internal');
      expect(JSON.stringify(e)).not.toMatch(/boom|secret|home/);
    } finally {
      console.error = quiet;
    }
  });
});

// ------------------------------------------------------------------ what the commands check

describe('the agent and shop commands take these answers as the calls they mean', () => {
  /** The commands' own checks (services/agent/src/status-api.ts): the answer's shape, then its calls, at its chain time. */
  const problems = (a: BuiltAction, calls: IntendedCall[]) => {
    expect(looksBuilt(a), JSON.stringify(a).slice(0, 300)).toBe(true);
    return signingProblems(a, { action: a.action, from: a.from, chainId: a.chainId, claimId: a.claimId, calls }, Number(a.builtAt));
  };
  const onClaims = (functionName: string, claimId: Hex): IntendedCall => ({ contract: 'RecourseClaims', to: CLAIMS, abi: CLAIMS_ABI, functionName, args: [claimId] });

  it('contest, closeUncontested, expireClaim and withdrawCredit', async () => {
    const r0 = await rig();
    r0.chain.state.claim = chainClaim({ orderId: r0.b.orderId, status: 2, answer: 1, preCheckedAt: SEQ_SECONDS });
    const contest = (await r0.post('contest', { from: PLATFORM, claimId: r0.b.claimId })).body as BuiltAction;
    expect(problems(contest, [onClaims('contest', r0.b.claimId)])).toEqual([]);
    expect(problems(contest, [onClaims('contest', h32(0xdead))]).join()).toContain('other arguments (claimId)');
    expect(problems(contest, [{ ...onClaims('contest', r0.b.claimId), to: VAULT }]).join()).toContain(`not RecourseClaims at ${VAULT}`);

    r0.chain.state.credit = 68_000_000n;
    const withdraw = (await r0.post('withdrawCredit', { from: SHOP })).body as BuiltAction;
    expect(problems(withdraw, [{ contract: 'DepositVault', to: VAULT, abi: VAULT_ABI, functionName: 'withdrawCredit', args: [] }])).toEqual([]);

    const lapsed = await rig({ stage: 'window_lapsed', now: SEQ_SECONDS + 601n });
    lapsed.chain.state.claim = chainClaim({ orderId: lapsed.b.orderId, status: 2, preCheckedAt: SEQ_SECONDS });
    const close = (await lapsed.post('closeUncontested', { from: SHOP2, claimId: lapsed.b.claimId })).body as BuiltAction;
    expect(problems(close, [onClaims('closeUncontested', lapsed.b.claimId)])).toEqual([]);
    expect(problems(close, [onClaims('expireClaim', lapsed.b.claimId)]).join()).toContain('its data calls closeUncontested');

    const filedAt = 1_700_000_000n;
    const old = await rig({ stage: 'filed', now: filedAt + 14_401n, chain: { escrow: 3_000_000n } });
    old.chain.state.claim = chainClaim({ orderId: old.b.orderId, status: 1, filedAt });
    const expire = (await old.post('expireClaim', { from: SHOP, claimId: old.b.claimId })).body as BuiltAction;
    expect(problems(expire, [onClaims('expireClaim', old.b.claimId)])).toEqual([]);
  });

  it('fileClaim after an approve of exactly the court fee, with the shop\'s own refs, basket and net loss', async () => {
    const r0 = await filing();
    const a = (await r0.post('fileClaim', { from: SHOP, platform: PLATFORM, orderNonce: N, basketUsdc: '25000000', netLossUsdc: '20000000' })).body as BuiltAction;
    const refs = { topicNum: 4000n, seq: [10n, 11n, 12n, 13n, 14n, 15n], hashes: r0.t.hashes };
    const approve = (amount: bigint): IntendedCall => ({ contract: 'VaultToken', to: TOKEN, abi: TOKEN_ABI, functionName: 'approve', args: [VAULT, amount] });
    const file = (r: typeof refs): IntendedCall => ({ contract: 'RecourseClaims', to: CLAIMS, abi: CLAIMS_ABI, functionName: 'fileClaim', args: [N, PLATFORM, r, 25_000_000n, 20_000_000n] });
    expect(problems(a, [approve(3_000_000n), file(refs)])).toEqual([]);
    expect(problems(a, [approve(1n), file(refs)]).join()).toContain('other arguments (amount)');
    expect(problems(a, [approve(3_000_000n), file({ ...refs, seq: [10n, 11n, 12n, 13n, 14n, 16n] })]).join()).toContain('other arguments (refs)');
  });

  it('submitEvidence with the external id of the attempt and the evidence text', async () => {
    const r0 = await rig({ stage: 'at_court', chain: { period: 0 } });
    r0.chain.state.kase = caseNow({ state: 2, attempts: 1, disputeIds: [901n, 0n] });
    const a = (await r0.post('submitEvidence', { from: SHOP, claimId: r0.b.claimId, name: 'Delivery photo', description: 'As it arrived.' })).body as BuiltAction;
    const text = JSON.stringify({ name: 'Delivery photo', description: 'As it arrived.' });
    const call = (attempt: number): IntendedCall => ({ contract: 'EvidenceModule', to: addressBook.arbitrum.evidenceModule, abi: EVIDENCE_ABI, functionName: 'submitEvidence', args: [externalIdUint(ARB_ID, CASE, r0.b.claimId, attempt), text] });
    expect(problems(a, [call(1)])).toEqual([]);
    expect(problems(a, [call(2)]).join()).toContain('other arguments (_externalDisputeID)');
  });
});
