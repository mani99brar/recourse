#!/usr/bin/env node
// Acts as an agent over HTTP against the public origin (the web server's /api, the path the tunnel
// serves): fetches the OpenAPI file, calls every v1 read and every action with valid and invalid
// input, and checks each answer against the served schemas (status, required fields, enums, closed
// error objects, a documented code for that path at its documented status). The shop's catalog and
// x402 paths are probed the same way on the shop's origin.
//
//   node api-agent.mjs [--dry] [--only spec,reads,actions,shop,rate] [--base URL] [--shop URL]
//   node api-agent.mjs --send --as <role> --action <name> [--claim <claimId>] [--body '<json>']
//   node api-agent.mjs --wait <claimId> --status <statusKey>[,<statusKey>...] [--timeout-s 1800]
//   node api-agent.mjs --selftest
//   node api-agent.mjs --check-signer --as <role>
//
// --check-signer loads the role's key exactly as --send does and prints only its address, whether it is
// the party map's, and its balance on both test chains. Nothing is built or sent: run it before a send.
//
// --selftest takes real answers (a claim, an unknown claim, a withdrawCredit build) and judges each as
// served, broken one way at a time, and against an expectation that is wrong on purpose: it passes only
// when every broken answer and wrong expectation fails. Builds only; nothing is signed.
//
// --dry (the default) builds and validates only: POST /v1/actions builds and simulates, nothing is
// signed or sent. 200 answers are decoded against the generated ABIs and simulated again on the
// chain's public RPC (eth_call + eth_estimateGas as `from`), so they end as `dry-only`.
//
// --send signs the built transactions with the role's keystore (packages/shared's loadSigner, in this
// process; the key never leaves it and is never printed), sends them in order on the test chain the
// answer names (296 or 421614 only, checked against the RPC), waits for each receipt, then reads
// readBack until it shows the change the preview promised. Roles: shop, platform, agent, buyer,
// ops-arb, ops-hedera; the role's address must match deployments/parties.json.
//
// --wait polls GET /v1/claims/{id} (read-only) until the claim reaches one of the statuses, and records
// the events that got it there (the keeper's own transactions, such as ClosedUncontested).
//
// Output: one JSON line per check (also in $E2E_RAW_DIR/api-agent-<time>.jsonl), then the test table.
// Exit codes: 0 every check passed (or was dry-only/blocked), 1 a check failed, 2 send refused.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  ACTION_CALLS, Http, PUBLIC_RPC, RAW, REPO, Results, Rpc, Spec, TEST_CHAINS, argv, callMismatch, loadParties, loadRoleSigner, partyAddresses,
  readBackShows, safeText, sendBuilt, sha256, sleep, stamp, viem,
} from './lib.mjs';

const o = argv({
  dry: 'bool', send: 'bool', as: 'str', action: 'str', claim: 'str', body: 'str', base: 'str', shop: 'str', client: 'str', out: 'str',
  only: 'str', 'hedera-rpc': 'str', 'arb-rpc': 'str', wait: 'str', status: 'str', 'timeout-s': 'str', selftest: 'bool', 'check-signer': 'bool',
});
const BASE = o.base ?? 'http://127.0.0.1:8788/api';
const SHOP = o.shop ?? 'http://127.0.0.1:8720';
const http = new Http({ base: BASE, client: o.client ?? `e2e-api-agent-${process.pid}` });
const res = new Results('api', o.out ?? join(RAW, `api-agent-${stamp()}.jsonl`));
const rpcs = { 296: new Rpc(296, o['hedera-rpc'] ?? PUBLIC_RPC[296]), 421614: new Rpc(421614, o['arb-rpc'] ?? PUBLIC_RPC[421614]) };
const only = new Set((o.only ?? 'spec,reads,actions,shop,rate').split(','));
await loadParties();

const HEX32 = (n) => '0x' + n.toString(16).padStart(64, '0');
const RANDOM32 = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const ZERO = '0x0000000000000000000000000000000000000000';
const TERMINAL = new Set(['settled', 'closed_uncontested', 'closed_undrawn', 'expired', 'unresolved']);
const CLAIM_ACTIONS = ['contest', 'closeUncontested', 'sendToCourt', 'resend', 'expireClaim', 'settle', 'openCase', 'refile', 'relayRuling', 'submitEvidence'];
const HEDERA_CLAIM_ACTIONS = ['contest', 'closeUncontested', 'sendToCourt', 'resend', 'expireClaim', 'settle'];

let spec;
let ctx; // { params, claims, details, parties }

const short = (v) => {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 120)}…(${s.length} chars)` : s;
};

/**
 * The verdict on one answer: transport, JSON, documented status, schema, and for an error the code's
 * enum, its documented status and (actions) the path's x-recourse-errors. `expect` narrows status/code.
 */
function judge(method, template, r, expect = {}) {
  const problems = [];
  const notes = [];
  if (r.status === 0) return { result: 'blocked', problems: [`no answer: ${r.error}`], notes };
  if (r.json === undefined) problems.push(`body is not JSON (${(r.headers['content-type'] ?? 'no content-type')})`);
  else if (!/application\/json/.test(r.headers['content-type'] ?? '')) problems.push(`content-type ${r.headers['content-type']}`);
  const op = spec.op(method, template);
  const ok2xx = r.status >= 200 && r.status < 300;
  const code = !ok2xx && r.json && typeof r.json.error === 'object' ? r.json.error?.code : !ok2xx && typeof r.json?.error === 'string' ? r.json.error : undefined;
  const v1 = template.startsWith('/v1/') || template === '/openapi.json';
  if (op && !(String(r.status) in (op.responses ?? {})) && r.status !== 405 && r.status !== 429) {
    problems.push(`HTTP ${r.status} is not documented for ${method} ${template}`);
  }
  if (!op && !expect.noOp) problems.push(`${method} ${template} is not in the spec`);
  if (ok2xx && r.json !== undefined) {
    const p = spec.responsePointer(method, template, r.status);
    if (p) {
      problems.push(...spec.validate(p, r.json).map((e) => `schema: ${e}`));
      const drift = spec.undeclared(p, r.json);
      if (drift.length) notes.push(`undeclared fields: ${drift.slice(0, 8).join(', ')}`);
    } else if (op) problems.push(`the spec gives no JSON schema for HTTP ${r.status} on ${method} ${template}: nothing to validate against`);
  } else if (!ok2xx && v1 && r.json !== undefined) {
    problems.push(...spec.validate('#/components/schemas/Error', r.json).map((e) => `error shape: ${e}`));
    // The spec closes the outer object only; API.md gives the inner one as exactly code, message, details.
    const inner = r.json?.error && typeof r.json.error === 'object' ? Object.keys(r.json.error).filter((k) => !['code', 'message', 'details'].includes(k)) : [];
    if (inner.length) problems.push(`error object holds ${inner.join(', ')} besides code, message, details`);
    if (code !== undefined) {
      if (!spec.codes.has(code)) problems.push(`code ${code} is not in ErrorCode`);
      const want = spec.codeStatus.get(code);
      if (want !== undefined && want !== r.status) problems.push(`code ${code} is documented at ${want}, answered ${r.status}`);
      const listed = op?.['x-recourse-errors'];
      if (listed && !listed.includes(code)) problems.push(`code ${code} is not in ${template}'s x-recourse-errors`);
    }
    // A URL is a scheme with a host; the bare words "an https:// link" in a field hint are not one.
    if (typeof r.json?.error?.message !== 'string' || /https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(r.json?.error?.message ?? '')) problems.push('message missing or holds a URL');
    if (r.status === 429 && !r.headers['retry-after']) problems.push('429 without retry-after');
  } else if (!ok2xx && !v1 && r.json !== undefined && r.status !== 402) {
    problems.push(...spec.validate('#/components/schemas/ShopError', r.json).map((e) => `shop error shape: ${e}`));
  }
  const statuses = expect.status === undefined ? null : [].concat(expect.status);
  if (statuses && !statuses.includes(r.status)) problems.push(`expected HTTP ${statuses.join('|')}, got ${r.status}${code ? ` ${code}` : ''}`);
  const codes = expect.code === undefined ? null : [].concat(expect.code);
  if (codes && !codes.includes(code)) problems.push(`expected ${codes.join('|')}, got ${code ?? `HTTP ${r.status}`}`);
  if (r.ms > 10_000) notes.push(`slow: ${r.ms} ms (actions answer within 12 s, the proxy waits 15 s)`);
  // An upstream outage that was not what the check is about: the path could not be tested this time.
  const upstreamDown = (r.status === 502 || r.status === 503) && code === 'upstream_unavailable' && !(codes ?? []).includes('upstream_unavailable');
  if (upstreamDown) {
    if (r.status === 502) notes.push('502 from the web server: openapi documents upstream_unavailable at 503, and API.md says details.upstream status_api');
    return { result: 'blocked', problems, notes, code };
  }
  return { result: problems.length ? 'fail' : 'pass', problems, notes, code };
}

async function probe(test, method, path, template, opts = {}) {
  const { body, raw, headers, expect, base, after, timeoutMs } = opts;
  const r = await http.request(method, base ? `${base}${path}` : path, { body, raw, headers, timeoutMs });
  // One retry when an upstream was down: the public mirror and hashio fail for seconds at a time.
  let rr = r;
  if ((r.status === 502 || r.status === 503 || r.status === 0) && !(expect?.code ?? '').includes?.('upstream')) {
    upstreamSeen.push({ path: `${method} ${template}`, http: r.status, ms: r.ms, code: r.json?.error?.code ?? null, message: r.json?.error?.message ?? r.error ?? null, details: r.json?.error?.details ?? null });
    await sleep(3000);
    rr = await http.request(method, base ? `${base}${path}` : path, { body, raw, headers, timeoutMs });
  }
  const v = judge(method, template, rr, expect);
  let extra = {};
  if (after && (v.result === 'pass' || v.result === 'fail')) {
    try {
      extra = (await after(rr, v)) ?? {};
    } catch (e) {
      v.problems.push(`after-check threw: ${safeText(e)}`);
      v.result = 'fail';
    }
  }
  if (extra.problems?.length) {
    v.problems.push(...extra.problems);
    v.result = 'fail';
  }
  const result = extra.result && v.result === 'pass' ? extra.result : v.result;
  res.add({
    test, path: `${method} ${template}`, input: short(body ?? raw), http: rr.status, ms: rr.ms, result, code: v.code,
    ...(v.problems.length ? { problems: v.problems } : {}), ...(v.notes.length || extra.notes?.length ? { notes: [...v.notes, ...(extra.notes ?? [])] } : {}),
    ...(extra.data ? { data: extra.data } : {}),
  });
  return rr;
}

// ---- the spec itself ----

async function specChecks() {
  const r = await http.request('GET', '/v1/openapi.json');
  if (r.status !== 200 || !r.json) throw new Error(`GET /v1/openapi.json answered ${r.status}; nothing can be checked`);
  spec = new Spec(r.json);
  const repoText = readFileSync(join(REPO, 'services/status-api/openapi.json'), 'utf8');
  const same = sha256(r.text) === sha256(repoText);
  res.add({ test: 'served spec loads (OpenAPI 3.1) and is the repo file', path: 'GET /v1/openapi.json', http: r.status, ms: r.ms, result: r.json.openapi?.startsWith('3.1') ? 'pass' : 'fail', notes: [same ? 'identical to services/status-api/openapi.json' : 'differs from services/status-api/openapi.json: the running status API predates the checkout or the reverse'] });
  if (!only.has('spec')) return;
  await probe('root copy of the spec is the same document', 'GET', '/openapi.json', '/openapi.json', {
    after: (rr) => ({ problems: sha256(rr.text) === sha256(r.text) ? [] : ['/openapi.json differs from /v1/openapi.json'] }),
  });
  const problems = [];
  const enumCodes = [...spec.codes].sort();
  const listCodes = (r.json['x-recourse-error-codes'] ?? []).map((c) => c.code).sort();
  if (JSON.stringify(enumCodes) !== JSON.stringify(listCodes)) problems.push(`ErrorCode enum (${enumCodes.length}) and x-recourse-error-codes (${listCodes.length}) differ`);
  for (const [p, item] of Object.entries(r.json.paths)) {
    for (const [m, op] of Object.entries(item)) {
      if (typeof op !== 'object' || !op.responses) continue;
      for (const c of op['x-recourse-errors'] ?? []) {
        if (!spec.codes.has(c)) problems.push(`${m} ${p}: x-recourse-errors names unknown ${c}`);
        const st = spec.codeStatus.get(c);
        if (st && !(String(st) in op.responses) && st !== 405) problems.push(`${m} ${p}: lists ${c} (HTTP ${st}) but documents no ${st} response`);
      }
    }
  }
  for (const m of r.json['x-recourse-revert-map'] ?? []) {
    if (!spec.codes.has(m.code)) problems.push(`revert map ${m.contract}.${m.error} -> unknown code ${m.code}`);
    else if (spec.codeStatus.get(m.code) !== m.status) problems.push(`revert map ${m.error}: status ${m.status} differs from ${m.code}'s`);
  }
  const actionEnum = r.json.components.schemas.ActionName?.enum ?? [];
  for (const a of actionEnum) if (!r.json.paths[`/v1/actions/${a}`]?.post) problems.push(`ActionName ${a} has no POST path`);
  res.add({ test: 'spec self-consistency: codes, statuses, revert map, action paths', path: 'spec openapi.json', result: problems.length ? 'fail' : 'pass', ...(problems.length ? { problems } : {}) });
}

// ---- discovery: everything from the API, so the harness works after a redeploy ----

/** Upstream failures seen on the way (the proxy's 502 after its 15 s wait, the API's 503), for the summary. */
const upstreamSeen = [];
/** HTTP statuses that mean the status API or one of its sources did not answer. */
const UPSTREAM_DOWN = [0, 502, 503];

/** A read discovery depends on, tried up to four times through upstream outages. */
async function getRetry(path, tries = 4) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await http.request('GET', path);
    if (r.status === 200) return r;
    if (r.status === 502 || r.status === 503 || r.status === 0) upstreamSeen.push({ path, http: r.status, ms: r.ms, code: r.json?.error?.code ?? null, message: r.json?.error?.message ?? r.error ?? null });
    else return r;
    await sleep(5000);
  }
  return r;
}

async function discover() {
  const p = await getRetry('/v1/params', 8);
  const c = await getRetry('/v1/claims');
  if (UPSTREAM_DOWN.includes(c.status)) {
    res.add({ test: 'discovery: /v1/claims did not answer in 4 tries', path: 'GET /v1/claims', http: c.status, ms: c.ms, result: 'blocked', notes: ['the status API could not serve reads (an upstream down): the reads and actions were not run'] });
    return false;
  }
  if (c.status !== 200) throw new Error(`claims ${c.status}: the API is not serving reads`);
  if (p.status !== 200) {
    // The rest still runs: chain ids are fixed, and the address checks on built answers are skipped.
    res.add({ test: 'discovery: params did not answer in 8 tries', path: 'GET /v1/params', http: p.status, ms: p.ms, result: 'blocked', notes: ['built transactions are not checked against params.addresses this run'] });
    p.json = { params: { addresses: {}, chains: { hedera: 296, arbitrum: 421614 } } };
  }
  const parties = partyAddresses();
  const details = {};
  for (const row of c.json.claims) {
    const d = await getRetry(`/v1/claims/${row.claimId}`);
    if (d.status === 200) details[row.claimId] = d.json.claim;
  }
  ctx = { params: p.json.params, claims: c.json.claims, details, parties };
  const credit = {};
  for (const role of ['shop', 'platform', 'scheme']) {
    const r = await getRetry(`/v1/parties/${parties[role]}`);
    credit[role] = r.json?.party?.credit ?? null;
  }
  ctx.credit = credit;
  res.add({
    test: 'discovery from the API', path: 'GET /v1/params + /v1/claims', result: 'pass',
    data: { claims: ctx.claims.map((x) => `${x.claimId.slice(0, 10)} ${x.statusKey}`), addresses: { claims: ctx.params.addresses.claims, vault: ctx.params.addresses.vault, recourseCase: ctx.params.addresses.recourseCase }, credit },
  });
  return true;
}

// ---- reads ----

async function reads() {
  const { claims, parties, details } = ctx;
  await probe('health', 'GET', '/v1/health', '/v1/health');
  await probe('params, with the twelve actions', 'GET', '/v1/params', '/v1/params', {
    after: (r) => {
      const want = spec.doc.components.schemas.ActionName.enum;
      const got = r.json?.params?.actions ?? [];
      return { problems: JSON.stringify([...got].sort()) === JSON.stringify([...want].sort()) ? [] : [`params.actions ${got.join(',')} differ from ActionName`] };
    },
  });
  await probe('claims list', 'GET', '/v1/claims', '/v1/claims', {
    after: (r) => ({ problems: r.json?.party === null ? [] : ['party should be null without ?party='] }),
  });
  for (const role of ['shop', 'platform']) {
    await probe(`claims for the ${role}, with standing and groups`, 'GET', `/v1/claims?party=${parties[role].toLowerCase()}`, '/v1/claims', {
      after: (r) => ({ problems: r.json?.party?.standing?.address === parties[role] ? [] : ['party.standing.address is not the checksummed party'] }),
    });
  }
  for (const s of [...new Set(claims.map((x) => x.statusKey))]) {
    await probe(`claims filtered by status ${s}`, 'GET', `/v1/claims?status=${s}`, '/v1/claims', {
      after: (r) => ({ problems: (r.json?.claims ?? []).every((x) => x.statusKey === s) ? [] : [`a claim not in ${s} was returned`] }),
    });
  }
  for (const row of claims) {
    await probe(`claim detail ${row.claimId.slice(0, 10)}`, 'GET', `/v1/claims/${row.claimId}`, '/v1/claims/{claimId}', {
      after: (r) => {
        const d = r.json?.claim;
        const problems = [];
        for (const k of ['statusKey', 'nextCall', 'nextActor', 'shop', 'platform', 'orderId']) if (d && JSON.stringify(d[k]) !== JSON.stringify(row[k])) problems.push(`${k} differs from the list row`);
        if (d && d.nextAction && d.nextAction.path !== `/v1/actions/${d.nextAction.action}`) problems.push('nextAction.path is not its action path');
        return { problems };
      },
    });
    await probe(`claim detail, upper-case id ${row.claimId.slice(0, 10)}`, 'GET', `/v1/claims/0x${row.claimId.slice(2).toUpperCase()}`, '/v1/claims/{claimId}', {
      after: (r) => ({ problems: r.json?.claim?.claimId === row.claimId ? [] : ['the answer does not give the id in lower case'] }),
    });
  }
  for (const role of ['shop', 'platform', 'scheme']) {
    await probe(`party ${role}`, 'GET', `/v1/parties/${parties[role].toLowerCase()}`, '/v1/parties/{address}', {
      after: (r) => ({ problems: r.json?.party?.address === parties[role] ? [] : ['address is not checksummed as sent back'] }),
    });
  }
  for (const row of claims) {
    await probe(`order records ${row.orderId.slice(0, 10)}`, 'GET', `/v1/orders/${row.orderId}/records`, '/v1/orders/{orderId}/records', {
      after: (r) => ({ problems: r.json?.order?.claimId === row.claimId ? [] : ['order.claimId is not the claim that names it'] }),
    });
    await probe(`order records with platform and shop ${row.orderId.slice(0, 10)}`, 'GET', `/v1/orders/${row.orderId}/records?platform=${row.platform}&shop=${row.shop}`, '/v1/orders/{orderId}/records');
  }
  const first = claims[0];
  const ev = first ? details[first.claimId]?.events?.[0]?.tx : null;
  const queries = first ? [['claim id', first.claimId], ['order id', first.orderId], ['shop address', first.shop], ...(ev ? [['event tx', ev]] : [])] : [];
  const dispute = Object.values(details).flatMap((d) => d.court?.disputeIds ?? [])[0];
  if (dispute) queries.push(['dispute number', dispute]);
  for (const [what, q] of queries) {
    await probe(`search by ${what}`, 'GET', `/v1/search?q=${encodeURIComponent(q)}`, '/v1/search', {
      after: (r) => ({ problems: (r.json?.search?.hits ?? []).length > 0 ? [] : [`no hit for a known ${what}`] }),
    });
  }

  // Invalid reads: each a typed error with a documented code.
  const bad = [
    ['status not a status key', '/v1/claims?status=nope', '/v1/claims', 400, 'invalid_field'],
    ['party not an address', '/v1/claims?party=0x1234', '/v1/claims', 400, 'invalid_field'],
    ['party given twice', `/v1/claims?party=${parties.shop}&party=${parties.platform}`, '/v1/claims', 400, 'invalid_field'],
    ['claim id short', '/v1/claims/0x1234', '/v1/claims/{claimId}', 400, 'invalid_field'],
    ['claim id unknown', `/v1/claims/${HEX32(1n)}`, '/v1/claims/{claimId}', 404, 'not_found'],
    ['party not hex', '/v1/parties/not-an-address', '/v1/parties/{address}', 400, 'invalid_field'],
    ['order id short', '/v1/orders/0x12/records', '/v1/orders/{orderId}/records', 400, 'invalid_field'],
    ['order records with platform only', `/v1/orders/${HEX32(2n)}/records?platform=${parties.platform}`, '/v1/orders/{orderId}/records', 400, 'missing_field'],
    ['search without q', '/v1/search', '/v1/search', 400, 'missing_field'],
    ['search q blank', '/v1/search?q=%20', '/v1/search', 400, 'invalid_field'],
    ['search q over 200 characters', `/v1/search?q=${'a'.repeat(201)}`, '/v1/search', 400, 'invalid_field'],
  ];
  for (const [what, path, template, status, code] of bad) await probe(`invalid: ${what}`, 'GET', path, template, { expect: { status, code } });
  await probe('invalid: unknown /v1 path', 'GET', '/v1/nope', '/v1/nope', { expect: { status: 404, code: 'not_found', noOp: true }, after: (r) => ({ problems: r.json?.error?.details?.resource === 'route' ? [] : ['details.resource is not route'] }) });
  await probe('invalid: POST on a read', 'POST', '/v1/health', '/v1/health', { body: {}, expect: { status: 405, code: 'method_not_allowed', noOp: true } });
  await probe('invalid: DELETE on claims', 'DELETE', '/v1/claims', '/v1/claims', { expect: { status: 405, code: 'method_not_allowed', noOp: true } });
}

// ---- actions ----

/** Every reason this built answer must not be signed; empty when an agent could sign it. */
function builtProblems(action, req, a) {
  const out = [];
  const { params } = ctx;
  if (a.action !== action) out.push(`built ${a.action}, asked ${action}`);
  if (a.from.toLowerCase() !== req.from.toLowerCase()) out.push('from is not the account asked for');
  if (a.from !== viem.getAddress(a.from)) out.push('from is not checksummed');
  if (!(a.chainId in TEST_CHAINS)) out.push(`chain ${a.chainId} is not a test network`);
  if (params.chains[a.chain] !== a.chainId) out.push(`chain ${a.chain} is ${params.chains[a.chain]}, the answer says ${a.chainId}`);
  if (req.claimId && a.claimId !== req.claimId.toLowerCase()) out.push('built for another claim');
  const where = {
    RecourseClaims: params.addresses.claims, DepositVault: params.addresses.vault, RecourseCase: params.addresses.recourseCase,
    EvidenceModule: params.addresses.evidenceModule, VaultToken: params.addresses.usdc,
  };
  const allowed = ACTION_CALLS[action];
  a.transactions.forEach((t, i) => {
    const n = `tx ${i + 1}`;
    if (t.chainId !== a.chainId) out.push(`${n} is on chain ${t.chainId}`);
    if (!allowed.includes(`${t.call.contract}.${t.call.function}`)) out.push(`${n} calls ${t.call.contract}.${t.call.function}, which ${action} never needs`);
    if (where[t.call.contract] && t.to?.toLowerCase() !== where[t.call.contract].toLowerCase()) out.push(`${n} goes to ${t.to}, params say ${t.call.contract} is ${where[t.call.contract]}`);
    const why = callMismatch(t);
    if (why) out.push(`${n}: ${why}`);
    if (t.call.function === 'approve') {
      const fee = a.preview.amounts.find((x) => x.name === 'courtFee');
      if (!fee || String(t.call.args.amount) !== fee.amount) out.push(`${n} approves a different amount from the court fee`);
    }
    if (BigInt(t.gas) <= 0n || BigInt(t.gasPrice) <= 0n) out.push(`${n} has no gas or gas price`);
  });
  if (a.simulated !== a.transactions.every((t) => t.simulated)) out.push('simulated does not match the transactions');
  const value = a.transactions.reduce((s, t) => s + BigInt(t.value), 0n);
  const shown = a.preview.amounts.filter((x) => x.movement === 'send').reduce((s, x) => s + BigInt(x.amount), 0n);
  if (value !== shown) out.push(`transactions send ${value}, the preview shows ${shown} sent`);
  const fee = a.transactions.reduce((s, t) => s + BigInt(t.gas) * BigInt(t.gasPrice), 0n);
  if (BigInt(a.preview.fee.amount) !== fee) out.push(`fee ${a.preview.fee.amount} is not the sum of gas x gasPrice (${fee})`);
  if (a.preview.fee.decimals !== 18 || a.preview.fee.symbol !== (a.chainId === 296 ? 'HBAR' : 'ETH')) out.push('fee unit is not the chain native unit');
  if (!/^\/v1\/(claims|parties)\/0x[0-9a-fA-F]+$/.test(a.readBack)) out.push(`readBack ${a.readBack} is not a /v1 read`);
  const age = Math.abs(Date.now() / 1000 - Number(a.builtAt));
  if (age > 300) out.push(`builtAt is ${Math.round(age)} s from now`);
  if (a.notAfter !== null && BigInt(a.notAfter) < BigInt(a.builtAt)) out.push('notAfter is before builtAt');
  return out;
}

/** Simulates each built transaction again on the chain's public RPC; only the first when one depends on another. */
async function resimulate(a) {
  const rpc = rpcs[a.chainId];
  const sims = [];
  for (const t of a.transactions) {
    if (!t.simulated) {
      sims.push({ fn: t.call.function, skipped: 'depends on the step before it' });
      continue;
    }
    const s = await rpc.simulate({ from: a.from, to: t.to, data: t.data, value: t.value });
    sims.push({ fn: t.call.function, gas: s.gas, revert: s.revert, unreachable: s.unreachable });
  }
  return sims;
}

async function action(test, name, body, expect, opts = {}) {
  return probe(test, 'POST', `/v1/actions/${name}`, `/v1/actions/${name}`, {
    ...opts,
    body: opts.raw === undefined ? body : undefined,
    expect,
    after: async (r) => {
      if (r.status !== 200 || !r.json) return {};
      const problems = builtProblems(name, body, r.json);
      const sims = await resimulate(r.json).catch((e) => [{ error: safeText(e) }]);
      for (const s of sims) if (s.revert || s.error) problems.push(`RPC simulation of ${s.fn ?? 'tx'} failed: ${short(s.revert ?? s.error)}`);
      for (const [i, s] of sims.entries()) if (s.gas && BigInt(s.gas) > BigInt(r.json.transactions[i].gas)) problems.push(`${s.fn} needs ${s.gas} gas now, built with ${r.json.transactions[i].gas}`);
      // An RPC that did not answer leaves the second simulation undone: the row is blocked, not failed.
      const down = sims.find((s) => s.unreachable);
      const pv = r.json.preview;
      return {
        problems,
        result: down ? 'blocked' : 'dry-only',
        notes: down ? [`not simulated again: the ${TEST_CHAINS[r.json.chainId]} RPC did not answer (${down.unreachable})`] : [],
        data: {
          chainId: r.json.chainId, txs: r.json.transactions.map((t) => `${t.call.contract}.${t.call.function} gas ${t.gas}`), amounts: pv.amounts.map((x) => `${x.name} ${x.display} ${x.movement}`),
          fee: pv.fee.display, statusAfter: pv.statusAfter, simulatedAgain: sims,
        },
      };
    },
  });
}

/** The account a role signs from in dry mode (the party map's); in send mode the key's own address. */
const as = (role) => ctx.parties[role];

/** A refusal of a call the claim's state does not offer: any documented 4xx refusal, never a transaction. */
const REFUSED = Object.freeze({ status: [403, 409, 422] });

/**
 * What the API must answer for `name` on claim `d` signed by `role`. The claim's nextAction is the call
 * due now (deriveStatus), so it must build, for its actor when the actor is a party; a call not due must
 * be refused. resend stays open (the claims contract cannot see the message arrived), and evidence goes
 * in while a dispute exists. Near the deadline the window may close between the read and the build.
 */
function expectFor(name, d, role) {
  const terminal = TERMINAL.has(d.statusKey);
  const caseState = d.court?.state ?? 'none';
  const next = d.nextAction;
  const due = next?.action === name;
  const party = next && ['shop', 'platform'].includes(next.actor);
  const closing = due && next.deadline !== null && Number(next.deadline) - Date.now() / 1000 < 60;
  if (name === 'submitEvidence') return (d.court?.disputeIds ?? []).length > 0 ? { status: 200 } : { status: [404, 409], code: ['not_found', 'no_dispute'] };
  if (HEDERA_CLAIM_ACTIONS.includes(name)) {
    if (terminal) return { status: 409, code: 'wrong_status' };
    if (due && party && next.actor !== role) return { status: 403, code: 'not_contester' };
    if (due) return closing ? { status: [200, 409] } : { status: 200 };
    return name === 'resend' ? {} : REFUSED;
  }
  if (caseState === 'none') return { status: 404, code: 'not_found' };
  if (due) return { status: 200 };
  // The claim is over on Hedera: no case call is due, and a paid one would carry nothing Hedera needs.
  if (terminal) return REFUSED;
  if (name === 'openCase') return caseState === 'received' ? {} : { status: 409, code: 'case_wrong_state' };
  if (name === 'refile') return caseState === 'refile_pending' ? {} : { status: 409, code: 'case_wrong_state' };
  return {};
}

const ROLE_FOR = {
  contest: ['platform', 'shop'], closeUncontested: ['ops-hedera'], sendToCourt: ['ops-hedera'], resend: ['ops-hedera'], expireClaim: ['ops-hedera'],
  settle: ['ops-hedera'], openCase: ['ops-arb'], refile: ['ops-arb'], relayRuling: ['ops-arb'], submitEvidence: ['ops-arb'],
};

async function actions() {
  const { claims, details, parties, credit } = ctx;
  const someClaim = claims[0]?.claimId ?? HEX32(3n);

  // Valid input: every claim action on every claim, from the role that would sign it.
  for (const row of claims) {
    const d = details[row.claimId];
    if (!d) continue;
    for (const name of CLAIM_ACTIONS) {
      for (const role of ROLE_FOR[name]) {
        let body = { from: as(role), claimId: row.claimId };
        if (name === 'submitEvidence') body = { ...body, name: 'Harness check: evidence preview', description: 'Built by the e2e harness in dry mode; never signed.' };
        if (name === 'relayRuling') {
          for (const payIn of ['native', 'link']) await action(`${name} ${row.claimId.slice(0, 10)} (${d.statusKey}) as ${role}, payIn ${payIn}`, name, { ...body, payIn }, expectFor(name, d, role));
          continue;
        }
        await action(`${name} ${row.claimId.slice(0, 10)} (${d.statusKey}) as ${role}`, name, body, expectFor(name, d, role));
      }
    }
    // The agent's way: follow nextAction as its actor.
    if (d.nextAction) {
      const role = { shop: 'shop', platform: 'platform', anyone: 'ops-hedera', keeper: 'ops-hedera' }[d.nextAction.actor] ?? 'ops-hedera';
      const body = d.nextAction.action === 'withdrawCredit' ? { from: as(role) } : { from: as(role), claimId: row.claimId };
      await action(`follow nextAction ${d.nextAction.action} of ${row.claimId.slice(0, 10)} as its actor ${d.nextAction.actor}`, d.nextAction.action, body, { status: 200 });
    }
  }
  await action('withdrawCredit as the shop', 'withdrawCredit', { from: as('shop') }, BigInt(credit.shop ?? '0') > 0n ? { status: 200 } : { status: 409, code: 'no_credit' });
  await action('withdrawCredit as an account with credit (scheme)', 'withdrawCredit', { from: as('scheme') }, BigInt(credit.scheme ?? '0') > 0n ? { status: 200 } : { status: 409, code: 'no_credit' });
  await action('withdrawCredit, body sent as text/plain (read as JSON whatever its type)', 'withdrawCredit', { from: as('shop') }, { status: [200, 409] }, { raw: JSON.stringify({ from: as('shop') }), headers: { 'content-type': 'text/plain' } });

  // fileClaim with valid input: claimed orders answer claim_exists, by orderId alone and by nonce + platform.
  for (const row of claims) {
    await action(`fileClaim by orderId alone ${row.orderId.slice(0, 10)} (already claimed)`, 'fileClaim', { from: as('shop'), orderId: row.orderId }, { status: 409, code: 'claim_exists' });
    const so = await http.request('GET', `${SHOP}/orders/${row.orderId}`);
    if (so.status === 200 && so.json?.order?.orderNonce) {
      await action(`fileClaim by nonce + platform ${row.orderId.slice(0, 10)} (already claimed)`, 'fileClaim', { from: as('shop'), platform: so.json.order.platform, orderNonce: so.json.order.orderNonce }, { status: 409, code: 'claim_exists' });
      await action('fileClaim, orderId that does not match nonce + platform', 'fileClaim', { from: as('shop'), platform: so.json.order.platform, orderNonce: so.json.order.orderNonce, orderId: HEX32(9n) }, { status: 422, code: 'order_id_mismatch' });
    }
  }
  const unknownOrder = RANDOM32();
  await action('fileClaim, orderId the shop does not know', 'fileClaim', { from: as('shop'), orderId: unknownOrder }, { status: 422, code: 'order_nonce_unknown' });
  await action('fileClaim, nonce with no ordered record', 'fileClaim', { from: as('shop'), platform: as('platform'), orderNonce: RANDOM32() }, { status: 422, code: 'no_ordered_record' });
  await action('fileClaim, platform is the shop itself', 'fileClaim', { from: as('shop'), platform: as('shop'), orderNonce: RANDOM32() }, { status: 422, code: 'same_party' });
  await action('fileClaim, neither orderId nor nonce + platform', 'fileClaim', { from: as('shop') }, { status: 400, code: 'missing_field' });
  await action('fileClaim, netLossUsdc not an integer string', 'fileClaim', { from: as('shop'), orderId: unknownOrder, netLossUsdc: '1.5' }, { status: 400, code: 'invalid_field' });
  await action('fileClaim, allowUnpacked not a boolean', 'fileClaim', { from: as('shop'), orderId: unknownOrder, allowUnpacked: 'yes' }, { status: 400, code: 'invalid_field' });
  await action('fileClaim, basketUsdc above uint256', 'fileClaim', { from: as('shop'), orderId: unknownOrder, basketUsdc: '1' + '0'.repeat(78) }, { status: 400, code: 'invalid_field' });

  // submitEvidence field checks.
  const ev = { from: as('ops-arb'), claimId: someClaim, name: 'Harness check', description: 'dry run' };
  await action('submitEvidence, name over 200 characters', 'submitEvidence', { ...ev, name: 'n'.repeat(201) }, { status: 400, code: 'invalid_field' });
  await action('submitEvidence, blank name', 'submitEvidence', { ...ev, name: '  ' }, { status: 400, code: 'invalid_field' });
  await action('submitEvidence, no description', 'submitEvidence', { from: ev.from, claimId: ev.claimId, name: ev.name }, { status: 400, code: 'missing_field' });
  await action('submitEvidence, fileURI not /ipfs/ or https', 'submitEvidence', { ...ev, fileURI: 'ftp://example.invalid/x' }, { status: 400, code: 'invalid_field' });
  await action('submitEvidence, attempt 3', 'submitEvidence', { ...ev, attempt: 3 }, { status: 400, code: 'invalid_field' });
  await action('submitEvidence, attempt as a string', 'submitEvidence', { ...ev, attempt: '1' }, { status: 400, code: 'invalid_field' });
  await action('submitEvidence, 50 KB description (over 49152 bytes, under 64 KB)', 'submitEvidence', { ...ev, description: 'x'.repeat(50_000) }, { status: 422, code: 'evidence_too_large' });
  await action('relayRuling, payIn not native or link', 'relayRuling', { from: as('ops-arb'), claimId: someClaim, payIn: 'btc' }, { status: 400, code: 'invalid_field' });

  // The same body checks on every action.
  for (const name of spec.doc.components.schemas.ActionName.enum) {
    const claimKey = name === 'withdrawCredit' || name === 'fileClaim' ? {} : { claimId: someClaim };
    const base = { from: as(name === 'fileClaim' || name === 'withdrawCredit' ? 'shop' : 'ops-hedera'), ...claimKey };
    await action(`${name}: empty object`, name, {}, { status: 400, code: 'missing_field' });
    await action(`${name}: from not an address`, name, { ...base, from: 'nope' }, { status: 400, code: 'invalid_field' });
    await action(`${name}: from the zero address`, name, { ...base, from: ZERO }, { status: 400, code: 'invalid_field' });
    await action(`${name}: an extra field (privateKey) is refused`, name, { ...base, privateKey: 'not-a-key' }, { status: 400, code: 'unknown_field' });
    await action(`${name}: body not JSON`, name, base, { status: 400, code: 'bad_json' }, { raw: '{not json', headers: { 'content-type': 'application/json' } });
    await action(`${name}: body a JSON array`, name, base, { status: 400, code: 'bad_json' }, { raw: '[]', headers: { 'content-type': 'application/json' } });
    await action(`${name}: body over 64 KB`, name, base, { status: 413, code: 'payload_too_large' }, { raw: JSON.stringify({ ...base, pad: 'p'.repeat(70_000) }), headers: { 'content-type': 'application/json' } });
    if (claimKey.claimId) {
      await action(`${name}: claimId short`, name, { ...base, claimId: '0x1234' }, { status: 400, code: 'invalid_field' });
      await action(`${name}: claimId unknown`, name, { ...base, claimId: HEX32(4n), ...(name === 'submitEvidence' ? { name: 'x', description: 'y' } : {}) }, { status: 404, code: 'not_found' });
    }
    await probe(`${name}: GET is refused`, 'GET', `/v1/actions/${name}`, `/v1/actions/${name}`, { expect: { status: 405, code: 'method_not_allowed', noOp: true } });
  }
  await probe('unknown action name', 'POST', '/v1/actions/stealFunds', '/v1/actions/stealFunds', { body: { from: as('shop') }, expect: { status: 404, code: 'not_found', noOp: true } });
}

// ---- the shop: catalog, orders, x402 payment request ----

async function shop() {
  const cat = await probe('shop catalog', 'GET', '/catalog', '/catalog', { base: SHOP });
  const item = cat.json?.items?.[0];
  const q1 = item?.quantities?.find((q) => q.quantity === 1);
  for (const row of ctx.claims.slice(0, 1)) {
    await probe('shop order by id (nonce and platform for an orderId-only fileClaim)', 'GET', `/orders/${row.orderId}`, '/orders/{orderId}', {
      base: SHOP, after: (r) => ({ problems: r.json?.order?.platform?.toLowerCase() === row.platform.toLowerCase() ? [] : ['order.platform is not the claim platform'] }),
    });
  }
  await probe('shop order unknown', 'GET', `/orders/${HEX32(5n)}`, '/orders/{orderId}', { base: SHOP, expect: { status: 404 } });
  if (!item || !q1) return;
  const path = q1.path ?? `/x402/orders/${item.sku}/1`;
  await probe('x402 order without the two order headers', 'POST', path, '/x402/orders/{sku}/{quantity}', { base: SHOP, body: {}, expect: { status: 400 }, after: (r) => ({ problems: r.json?.error === 'bad_order_headers' ? [] : [`error ${r.json?.error}`] }) });
  const hdr = (platform) => ({ 'x-recourse-platform': platform, 'x-recourse-order-nonce': RANDOM32() });
  await probe('x402 order for an unknown item', 'POST', '/x402/orders/no-such-item/1', '/x402/orders/{sku}/{quantity}', { base: SHOP, body: {}, headers: hdr(as('platform')), expect: { status: 404 } });
  await probe('x402 order from an account that is not a platform', 'POST', path, '/x402/orders/{sku}/{quantity}', { base: SHOP, body: {}, headers: hdr(as('shop')), expect: { status: 403 } });
  await probe('x402 order, no payment yet: the payment request (nothing settles)', 'POST', path, '/x402/orders/{sku}/{quantity}', {
    base: SHOP, body: {}, headers: hdr(as('platform')), expect: { status: 402 },
    after: (r) => {
      const raw = r.headers['payment-required'];
      if (!raw) return { problems: ['402 without PAYMENT-REQUIRED'] };
      let pr;
      try {
        pr = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      } catch {
        return { problems: ['PAYMENT-REQUIRED is not base64 JSON'] };
      }
      const problems = spec.validate('#/components/schemas/X402PaymentRequired', pr).map((e) => `x402: ${e}`);
      const acc = pr.accepts?.[0];
      if (acc && q1.price?.amount && acc.amount !== q1.price.amount) problems.push(`asks ${acc.amount}, the catalog says ${q1.price.amount}`);
      if (acc && cat.json?.payTo && acc.payTo !== cat.json.payTo) problems.push(`payTo ${acc.payTo}, the catalog says ${cat.json.payTo}`);
      return { problems, data: { scheme: acc?.scheme, network: acc?.network, amount: acc?.amount, asset: acc?.asset, payTo: acc?.payTo } };
    },
  });
  await probe('x402 ping, no payment', 'POST', '/x402/ping-order', '/x402/ping-order', { base: SHOP, expect: { status: 402 } });
}

// ---- the rate limit, on its own client so the rest of the run keeps its allowance ----

async function rate() {
  const client = `e2e-rate-${process.pid}`;
  const answers = [];
  for (let i = 0; i < 14; i++) answers.push(await http.request('POST', '/v1/actions/withdrawCredit', { raw: '[]', headers: { 'content-type': 'application/json' }, retries: 0, pace: false, client }));
  const limited = answers.find((r) => r.status === 429);
  if (!limited) {
    res.add({ test: 'action rate limit: 14 at once from one client', path: 'POST /v1/actions/withdrawCredit', result: 'fail', problems: [`no 429 in 14 quick posts (statuses ${answers.map((r) => r.status).join(',')})`] });
    return;
  }
  const v = judge('POST', '/v1/actions/withdrawCredit', limited, { status: 429, code: 'rate_limited' });
  res.add({ test: 'action rate limit: 14 at once from one client', path: 'POST /v1/actions/withdrawCredit', http: 429, result: v.result, code: v.code, notes: [`first 429 after ${answers.indexOf(limited)} posts, retry-after ${limited.headers['retry-after']}`], ...(v.problems.length ? { problems: v.problems } : {}) });
}

// ---- send mode ----

async function send() {
  if (!o.as || !o.action) throw new Error('--send needs --as <role> and --action <name>');
  const account = await loadRoleSigner(o.as);
  const parties = partyAddresses();
  if (parties[o.as] && parties[o.as] !== account.address) throw new Error(`the ${o.as} key is ${account.address}; deployments/parties.json says ${parties[o.as]}`);
  const r0 = await http.request('GET', '/v1/openapi.json');
  spec = new Spec(r0.json);
  // A send is checked against the live addresses, so without them nothing is sent.
  const p = await getRetry('/v1/params', 8);
  if (p.status !== 200 || !p.json?.params?.addresses) throw new Error(`/v1/params answered ${p.status} after 8 tries: the build cannot be checked against the live addresses, nothing sent`);
  ctx = { params: p.json.params, parties };
  const body = { from: account.address, ...(o.claim ? { claimId: o.claim } : {}), ...(o.body ? JSON.parse(o.body) : {}) };
  const build = () => http.request('POST', `/v1/actions/${o.action}`, { body });
  const r = await build();
  const v = judge('POST', `/v1/actions/${o.action}`, r, { status: 200 });
  if (r.status !== 200) {
    res.add({ test: `${o.action} as ${o.as}: build`, path: `POST /v1/actions/${o.action}`, http: r.status, result: v.result, code: v.code, problems: v.problems, notes: [r.json?.error?.message ?? ''] });
    return 2;
  }
  const a = r.json;
  // An answer outside the spec is not signed either: the schema problems judge found come first.
  const problems = [...v.problems, ...builtProblems(o.action, body, a)];
  if (problems.length) {
    res.add({ test: `${o.action} as ${o.as}: build`, path: `POST /v1/actions/${o.action}`, http: 200, result: 'fail', problems });
    return 2;
  }
  if (a.notAfter !== null && Date.now() / 1000 > Number(a.notAfter)) throw new Error('the call deadline (notAfter) has passed');
  console.error(`preview: ${a.preview.summary}`);
  for (const x of a.preview.amounts) console.error(`  ${x.name}: ${x.display} (${x.movement})`);
  console.error(`  fee: at most ${a.preview.fee.display} on ${TEST_CHAINS[a.chainId]}`);
  const hashes = [];
  for (let i = 0; i < a.transactions.length; i++) {
    let t = a.transactions[i];
    if (!t.simulated && i > 0) {
      // Estimated again now that the step before it has mined, as the web app does; never above the budget.
      const again = await build();
      const same = again.status === 200 && again.json.transactions.find((x) => x.simulated && x.to.toLowerCase() === t.to.toLowerCase() && x.data.toLowerCase() === t.data.toLowerCase());
      if (same && BigInt(same.gas) <= BigInt(t.gas)) t = { ...t, gas: same.gas };
      else if (same) throw new Error(`step ${i + 1} now needs ${same.gas} gas, above its budget ${t.gas}; nothing more sent`);
    }
    // The chain is asked once more just before signing (a step after another has only now become simulable).
    const sim = await rpcs[t.chainId].simulate({ from: account.address, to: t.to, data: t.data, value: t.value });
    if (sim.revert || sim.unreachable || (sim.gas !== null && BigInt(sim.gas) > BigInt(t.gas))) {
      const why = sim.revert ? `the RPC simulation reverts: ${short(sim.revert)}` : sim.unreachable ? `the RPC did not answer: ${sim.unreachable}` : `needs ${sim.gas} gas, the limit is ${t.gas}`;
      res.add({ test: `${o.action} as ${o.as}: step ${i + 1} ${t.call.contract}.${t.call.function} not sent`, path: `POST /v1/actions/${o.action}`, result: 'fail', txHash: hashes.join(' ') || undefined, problems: [why] });
      return 1;
    }
    const sent = await sendBuilt(account, rpcs[t.chainId], t);
    hashes.push(sent.hash);
    res.add({ test: `${o.action} as ${o.as}: step ${i + 1} ${t.call.contract}.${t.call.function}`, path: `POST /v1/actions/${o.action}`, result: sent.status === 'success' ? 'pass' : 'fail', txHash: sent.hash, data: { chainId: t.chainId, gasUsed: sent.gasUsed, block: sent.block } });
    if (sent.status !== 'success') return 1;
  }
  const deadline = Date.now() + 180_000;
  let last = null;
  while (Date.now() < deadline) {
    const rb = await http.request('GET', a.readBack);
    if (rb.status === 200) {
      last = rb.json;
      if (readBackShows(a, rb.json, hashes)) {
        const now = rb.json.claim ? `status ${rb.json.claim.statusKey}` : `credit ${rb.json.party.credit}`;
        res.add({ test: `${o.action} as ${o.as}: read back ${a.readBack}`, path: `GET ${a.readBack.replace(/0x[0-9a-fA-F]+$/, '{id}')}`, result: 'pass', txHash: hashes.join(' '), notes: [now] });
        return 0;
      }
    }
    await sleep(3000);
  }
  res.add({ test: `${o.action} as ${o.as}: read back ${a.readBack}`, path: `GET ${a.readBack}`, result: 'fail', txHash: hashes.join(' '), problems: ['the read did not show the change within 180 s'], notes: [last?.claim?.statusKey ?? last?.party?.credit ?? 'no answer'] });
  return 1;
}

// ---- signer check: the send path's key loading, with nothing built or sent ----

/** Loads the role's key as send mode does, checks its address against the party map, reads its balances. */
async function checkSigner() {
  if (!o.as) throw new Error('--check-signer needs --as <role>');
  const account = await loadRoleSigner(o.as);
  const want = partyAddresses()[o.as];
  const balances = {};
  for (const id of [296, 421614]) {
    await rpcs[id].guard();
    balances[TEST_CHAINS[id]] = viem.formatEther(BigInt(await rpcs[id].call('eth_getBalance', [account.address, 'latest'])));
  }
  const ok = want === undefined || want === account.address;
  res.add({ test: `${o.as} key loads in this process (address ${account.address})`, path: `signer ${o.as}`, result: ok ? 'pass' : 'fail', ...(ok ? {} : { problems: [`deployments/parties.json says ${want}`] }), data: { balances } });
  return ok ? 0 : 1;
}

// ---- self-test: the checks fail on a wrong answer and on a wrong expectation ----

/**
 * Takes real answers from the API, then runs judge (and builtProblems for a build) on each as served, on
 * copies broken one way each, and with expectations that are wrong on purpose. A row passes when the check
 * said what it should: the served answer passes, every broken one or wrong expectation fails.
 */
async function selftest() {
  const r0 = await http.request('GET', '/v1/openapi.json');
  if (r0.status !== 200 || !r0.json) throw new Error(`GET /v1/openapi.json answered ${r0.status}`);
  spec = new Spec(r0.json);
  const list = await getRetry('/v1/claims');
  if (UPSTREAM_DOWN.includes(list.status)) {
    res.add({ test: 'selftest: /v1/claims did not answer in 4 tries', path: 'selftest GET /v1/claims', http: list.status, result: 'blocked', notes: ['no real answer to test the checks with (an upstream down)'] });
    return 0;
  }
  if (list.status !== 200 || !list.json?.claims?.length) throw new Error(`claims ${list.status}: no claim to take an answer from`);
  const id = list.json.claims[0].claimId;
  const detail = await getRetry(`/v1/claims/${id}`);
  const missing = await http.request('GET', `/v1/claims/${HEX32(1n)}`);
  if (detail.status !== 200 || missing.status !== 404) throw new Error(`claim ${detail.status}, unknown claim ${missing.status}: no answers to test with`);
  const copy = (r, f, extra = {}) => {
    const json = JSON.parse(JSON.stringify(r.json));
    if (f) f(json);
    return { ...r, ...extra, json, text: JSON.stringify(json) };
  };
  const C = ['GET', '/v1/claims/{claimId}'];
  const L = ['GET', '/v1/claims'];
  const cases = [
    ['claim detail as served', ...C, detail, {}, 'pass'],
    ['claim detail, statusKey not in its enum', ...C, copy(detail, (j) => (j.claim.statusKey = 'bogus')), {}, 'fail'],
    ['claim detail, claimId deleted (required)', ...C, copy(detail, (j) => delete j.claim.claimId), {}, 'fail'],
    ['claim detail, claimId a number', ...C, copy(detail, (j) => (j.claim.claimId = 1)), {}, 'fail'],
    ['claim detail, meta deleted', ...C, copy(detail, (j) => delete j.meta), {}, 'fail'],
    ['claim detail at HTTP 201 (not documented)', ...C, copy(detail, null, { status: 201 }), {}, 'fail'],
    ['claim detail served as text/html', ...C, copy(detail, null, { headers: { ...detail.headers, 'content-type': 'text/html' } }), {}, 'fail'],
    ['claim detail, expected 404 on purpose', ...C, detail, { status: 404, code: 'not_found' }, 'fail'],
    ['claims list as served', ...L, list, {}, 'pass'],
    ['claims list, claims an object', ...L, copy(list, (j) => (j.claims = {})), {}, 'fail'],
    ['claims list, a row with nextActor not in its enum', ...L, copy(list, (j) => (j.claims[0].nextActor = 'nobody')), {}, 'fail'],
    ['unknown claim as served (404 not_found)', ...C, missing, { status: 404, code: 'not_found' }, 'pass'],
    ['unknown claim, expected 400 invalid_field on purpose', ...C, missing, { status: 400, code: 'invalid_field' }, 'fail'],
    ['error, code not in ErrorCode', ...C, copy(missing, (j) => (j.error.code = 'made_up')), {}, 'fail'],
    ['error, message deleted', ...C, copy(missing, (j) => delete j.error.message), {}, 'fail'],
    ['error, a key beside error', ...C, copy(missing, (j) => (j.stack = 'at x')), {}, 'fail'],
    ['error, a key inside error beside code, message, details', ...C, copy(missing, (j) => (j.error.stack = 'at x')), {}, 'fail'],
    ['error, a URL in the message', ...C, copy(missing, (j) => (j.error.message = 'See https://mirror.example.invalid/api for more.')), {}, 'fail'],
    ['error, a code documented at another status (wrong_status at 404)', ...C, copy(missing, (j) => (j.error.code = 'wrong_status')), {}, 'fail'],
    ['error, a code this path does not list (no_credit at 409)', ...C, copy(missing, (j) => (j.error.code = 'no_credit'), { status: 409 }), {}, 'fail'],
    ['error, the old shape {error: code}', ...C, copy(missing, (j) => (j.error = 'not_found')), {}, 'fail'],
    ['action error, a code at its status that the action does not list (withdrawCredit wrong_status 409)', 'POST', '/v1/actions/withdrawCredit', copy(missing, (j) => (j.error.code = 'wrong_status'), { status: 409 }), {}, 'fail'],
    ['action error, a listed code at its status (withdrawCredit no_credit 409)', 'POST', '/v1/actions/withdrawCredit', copy(missing, (j) => (j.error.code = 'no_credit'), { status: 409 }), {}, 'pass'],
  ];
  for (const [what, method, template, r, expect, want] of cases) {
    const v = judge(method, template, r, expect);
    res.add({ test: `selftest: ${what} is judged ${want}`, path: `selftest ${method} ${template}`, result: v.result === want ? 'pass' : 'fail', notes: [`judged ${v.result}`, ...v.problems.slice(0, 2)] });
  }

  // A build an agent would sign, broken the ways that must stop a signature.
  const p = await getRetry('/v1/params', 8);
  if (p.status !== 200) {
    res.add({ test: 'selftest: a built answer and its broken copies', path: 'selftest POST /v1/actions/withdrawCredit', result: 'blocked', notes: [`/v1/params answered ${p.status}`] });
    return res.rows.some((x) => x.result === 'fail') ? 1 : 0;
  }
  ctx = { params: p.json.params, parties: partyAddresses() };
  let built = null;
  const tried = [];
  for (const role of ['scheme', 'shop', 'platform']) {
    const body = { from: ctx.parties[role] };
    // An upstream outage gets two more tries; a refusal (no_credit) moves on to the next party.
    for (let i = 0; i < 3 && !built; i++) {
      const r = await http.request('POST', '/v1/actions/withdrawCredit', { body });
      tried.push(`${role} ${r.status} ${r.json?.error?.code ?? ''}`.trim());
      if (r.status === 200) built = { r, body };
      else if (![0, 502, 503].includes(r.status)) break;
      else await sleep(5000);
    }
    if (built) break;
  }
  if (!built) {
    res.add({ test: 'selftest: a built answer and its broken copies', path: 'selftest POST /v1/actions/withdrawCredit', result: 'blocked', notes: [`no withdrawCredit built: ${tried.join(', ')}`] });
    return res.rows.some((x) => x.result === 'fail') ? 1 : 0;
  }
  const A = ['POST', '/v1/actions/withdrawCredit'];
  const t = (j) => j.transactions[0];
  const builds = [
    ['withdrawCredit build as served', built.r, null, 'pass'],
    ['build for a mainnet chain id (1)', built.r, (j) => { j.chainId = 1; t(j).chainId = 1; }, 'fail'],
    ['build sent to another contract', built.r, (j) => (t(j).to = '0x000000000000000000000000000000000000dEaD'), 'fail'],
    ['build whose data calls another function', built.r, (j) => (t(j).data = viem.encodeFunctionData({ abi: viem.erc20Abi, functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 1n] })), 'fail'],
    ['build with a value the preview does not show', built.r, (j) => (t(j).value = '1'), 'fail'],
    ['build whose fee is not gas x gasPrice', built.r, (j) => (j.preview.fee.amount = '1'), 'fail'],
    ['build from another account', built.r, (j) => (j.from = ctx.parties.platform === j.from ? ctx.parties.shop : ctx.parties.platform), 'fail'],
    ['build, movement not in its enum', built.r, (j) => (j.preview.amounts[0].movement = 'steal'), 'fail'],
    ['build, transactions deleted', built.r, (j) => delete j.transactions, 'fail'],
  ];
  for (const [what, r, f, want] of builds) {
    const rr = copy(r, f);
    const v = judge(...A, rr, { status: 200 });
    let problems = [...v.problems];
    try {
      problems.push(...builtProblems('withdrawCredit', built.body, rr.json));
    } catch (e) {
      problems.push(`builtProblems threw: ${safeText(e)}`);
    }
    const got = problems.length ? 'fail' : 'pass';
    res.add({ test: `selftest: ${what} is judged ${want}`, path: `selftest ${A.join(' ')}`, result: got === want ? 'pass' : 'fail', notes: [`judged ${got}`, ...problems.slice(0, 2)] });
  }
  return res.rows.some((x) => x.result === 'fail') ? 1 : 0;
}

// ---- wait mode ----

async function wait() {
  const until = Date.now() + Number(o['timeout-s'] ?? 1800) * 1000;
  if (!o.status) throw new Error('--wait needs --status <statusKey>[,<statusKey>...]');
  const wanted = new Set(o.status.split(','));
  const want = o.status.replaceAll(',', ' or ');
  let seen = null;
  while (Date.now() < until) {
    const r = await http.request('GET', `/v1/claims/${o.wait}`);
    if (r.status === 200) {
      const c = r.json.claim;
      if (c.statusKey !== seen) console.error(`claim ${o.wait.slice(0, 10)}: ${c.statusKey}, next ${c.nextCall ?? 'none'} by ${c.nextActor}`);
      seen = c.statusKey;
      if (wanted.has(c.statusKey)) {
        const evs = (c.events ?? []).map((e) => `${e.name} ${e.tx}`);
        res.add({ test: `claim ${o.wait.slice(0, 10)} reaches ${want}: ${c.statusKey}`, path: 'GET /v1/claims/{claimId}', result: 'pass', txHash: c.events?.at(-1)?.tx, data: { statusKey: c.statusKey, answer: c.answer ?? null, windowEndsAt: c.contest?.windowEndsAt ?? null, events: evs } });
        return 0;
      }
    }
    await sleep(15_000);
  }
  res.add({ test: `claim ${o.wait.slice(0, 10)} reaches ${want}`, path: 'GET /v1/claims/{claimId}', result: 'fail', problems: [`still ${seen} after the timeout`] });
  return 1;
}

async function main() {
  if (o.selftest) return selftest();
  if (o['check-signer']) return checkSigner();
  if (o.wait) return wait();
  if (o.send) return send();
  await specChecks();
  if (!(await discover())) return res.rows.some((r) => r.result === 'fail') ? 1 : 0;
  if (only.has('reads')) await reads();
  if (only.has('actions')) await actions();
  if (only.has('shop')) await shop();
  if (only.has('rate')) await rate();
  // Every upstream failure the run waited through, judged against the contract for it: the web server
  // answers its own 502 as upstream_unavailable with details.upstream status_api (API.md), and the
  // OpenAPI file documents upstream_unavailable at 503.
  const proxy = upstreamSeen.filter((u) => u.http === 502);
  const problems = proxy.filter((u) => u.details?.upstream !== 'status_api').map((u) => `${u.path}: 502 after ${u.ms} ms, "${u.message}", no details.upstream`);
  res.add({
    test: 'upstream failures during the run use the documented shape', path: 'proxy /api -> status API', result: problems.length ? 'fail' : 'pass',
    data: { seen: upstreamSeen.length, by502: proxy.length, by503: upstreamSeen.filter((u) => u.http === 503).length, noAnswer: upstreamSeen.filter((u) => u.http === 0).length },
    ...(problems.length ? { problems: problems.slice(0, 6) } : {}),
  });
  return res.rows.some((r) => r.result === 'fail') ? 1 : 0;
}

main().then(
  (code) => {
    console.error(`\n${res.table()}\n\nresults: ${res.file}${http.seen429 ? `\n429 answers waited out: ${http.seen429}` : ''}`);
    process.exit(code);
  },
  (e) => {
    console.error(`api-agent: ${safeText(e)}`);
    if (res.rows.length) console.error(`\n${res.table()}`);
    process.exit(1);
  },
);
