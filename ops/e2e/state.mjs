#!/usr/bin/env node
// What the checkout's deployments say, and what the running status API says, for run.sh.
//
//   node state.mjs deployments          the checkout's contracts, chain ids, vault token and records topic (JSON)
//   node state.mjs preflight            GET /v1/health and /v1/params name the same contracts, chain ids and
//                                       topic as deployments/*.json; exit 0 same, 3 different, 4 not readable
//   node state.mjs claim <claimId>      the claim's statusKey, pre-check answer and contest window (JSON)
//   node state.mjs order <orderId>      the claim id an order has, or null (JSON)
//   node state.mjs party <role>         credit, deposit, required, inGoodStanding, topUpDeadline, and the vault
//                                       token balance (JSON)
//
// The checkout is read with the status API's own loader (services/status-api/src/deployments.ts) and the
// records package's topic loader; the API is STATUS_API_URL (default http://127.0.0.1:8787). Read-only.
// The records topic is printed only when it comes from the committed packages/records/h0-ids.json, never
// when it comes from the environment.

import { join } from 'node:path';
import { Http, PUBLIC_RPC, RAW, Results, Rpc, checkoutDeployments, loadParties, partyAddresses, safeText, sleep, stamp, viem } from './lib.mjs';

const [cmd, arg] = process.argv.slice(2);
const API = (process.env.STATUS_API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const http = new Http({ base: API, client: `e2e-state-${process.pid}` });

/** A read with a few tries through upstream outages; null when it never answered 200. */
async function read(path, { tries = 3, timeoutMs = 30_000 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await http.request('GET', path, { timeoutMs });
    if (r.status === 200 && r.json) return { ok: true, json: r.json, ms: r.ms };
    last = r;
    if (r.status !== 0 && r.status < 500) break;
    if (i < tries - 1) await sleep(5000);
  }
  return { ok: false, status: last?.status ?? 0, error: last?.error ?? last?.json?.error?.code ?? null, ms: last?.ms ?? 0 };
}

const same = (a, b) => (a === null || b === null || a === undefined || b === undefined ? a === b : String(a).toLowerCase() === String(b).toLowerCase());

async function preflight() {
  const res = new Results('preflight', join(RAW, `preflight-${stamp()}.jsonl`));
  const d = await checkoutDeployments();
  const topicShown = d.topicFrom === 'HCS_RECORDS_TOPIC_ID' ? 'the one HCS_RECORDS_TOPIC_ID names' : d.recordsTopic;
  let mismatch = false;
  let unread = false;

  const h = await read('/v1/health', { timeoutMs: 20_000 });
  if (!h.ok) {
    unread = true;
    res.add({ path: 'GET /v1/health vs deployments/*.json', test: 'the status API names the checkout\'s deployment files and vault token', result: 'blocked', http: h.status, notes: [`/v1/health did not answer in 3 tries (HTTP ${h.status}${h.error ? `, ${h.error}` : ''})`] });
  } else {
    const problems = [];
    const files = h.json.health?.deployments?.files ?? [];
    if (JSON.stringify([...files].sort()) !== JSON.stringify([...d.files].sort())) problems.push(`files: API ${files.join(',') || 'none'}, checkout ${d.files.join(',') || 'none'}`);
    if ((h.json.health?.deployments?.local ?? null) !== d.local) problems.push(`local: API ${h.json.health?.deployments?.local}, checkout ${d.local}`);
    const vt = h.json.meta?.vaultToken ?? {};
    if (!same(vt.address, d.usdc)) problems.push(`vault token: API ${vt.address}, deployments/hedera.json ${d.usdc}`);
    if (vt.mode !== d.vaultToken.mode) problems.push(`vault token mode: API ${vt.mode}, deployments/hedera.json ${d.vaultToken.mode}`);
    if (problems.length) mismatch = true;
    res.add({ path: 'GET /v1/health vs deployments/*.json', test: 'the status API names the checkout\'s deployment files and vault token', result: problems.length ? 'fail' : 'pass', ...(problems.length ? { problems } : {}), data: { files, vaultToken: vt.address } });
  }

  const p = await read('/v1/params', { timeoutMs: 40_000 });
  if (!p.ok) {
    unread = true;
    res.add({ path: 'GET /v1/params vs deployments/*.json', test: 'the status API names the checkout\'s contracts, chain ids and records topic', result: 'blocked', http: p.status, notes: [`/v1/params did not answer in 3 tries (HTTP ${p.status}${p.error ? `, ${safeText(p.error)}` : ''}); it reads the contracts' params over the Hedera JSON-RPC relay`] });
  } else {
    const pa = p.json.params ?? {};
    const problems = [];
    const want = { claims: d.claims, vault: d.vault, recourseCase: d.recourseCase, usdc: d.usdc, evidenceModule: d.evidenceModule, klerosCore: d.klerosCore };
    for (const [k, v] of Object.entries(want)) if (!same(pa.addresses?.[k], v)) problems.push(`${k}: API ${pa.addresses?.[k] ?? 'null'}, checkout ${v ?? 'null'}`);
    for (const k of ['hedera', 'arbitrum']) if (pa.chains?.[k] !== d.chains[k]) problems.push(`chain ${k}: API ${pa.chains?.[k]}, checkout ${d.chains[k]}`);
    if (!same(pa.recordsTopic ?? null, d.recordsTopic)) problems.push(`records topic: API ${pa.recordsTopic ?? 'null'}, checkout ${topicShown ?? 'none'}`);
    if (problems.length) mismatch = true;
    res.add({ path: 'GET /v1/params vs deployments/*.json', test: 'the status API names the checkout\'s contracts, chain ids and records topic', result: problems.length ? 'fail' : 'pass', ms: p.ms, ...(problems.length ? { problems } : {}), data: { addresses: want, chains: d.chains, recordsTopic: pa.recordsTopic ?? null } });
  }
  console.error(`\n${res.table()}`);
  return mismatch ? 3 : unread ? 4 : 0;
}

async function claim(id) {
  const r = await read(`/v1/claims/${id}`);
  if (!r.ok) return { ok: false, http: r.status };
  const c = r.json.claim;
  return {
    ok: true, claimId: c.claimId, statusKey: c.statusKey, answer: c.answer ?? c.precheck?.answer ?? null, windowEndsAt: c.contest?.windowEndsAt ?? null,
    nextAction: c.nextAction ?? null, lastEvent: c.events?.at(-1) ?? null,
  };
}

async function order(id) {
  const r = await read(`/v1/orders/${id}/records`);
  if (!r.ok) return { ok: false, http: r.status };
  return { ok: true, orderId: id, claimId: r.json.order?.claimId ?? null };
}

async function party(role) {
  await loadParties();
  const address = partyAddresses()[role];
  if (!address) throw new Error(`no ${role} in the party map`);
  const r = await read(`/v1/parties/${address}`);
  const out = { role, address, ok: r.ok, http: r.ok ? 200 : r.status };
  if (r.ok) {
    const p = r.json.party;
    Object.assign(out, { credit: p.credit, balance: p.balance, required: p.required, inGoodStanding: p.inGoodStanding, topUpDeadline: p.topUpDeadline ?? null });
  }
  // The vault token in the party's own wallet, read from the chain (the API serves vault figures only).
  const d = await checkoutDeployments();
  const rpc = new Rpc(d.chains.hedera, process.env.E2E_HEDERA_RPC || PUBLIC_RPC[d.chains.hedera]);
  try {
    await rpc.guard();
    const data = viem.encodeFunctionData({ abi: viem.erc20Abi, functionName: 'balanceOf', args: [address] });
    out.tokenBalance = BigInt(await rpc.call('eth_call', [{ to: d.usdc, data }, 'latest'])).toString();
  } catch (e) {
    out.tokenBalance = null;
    out.tokenError = safeText(e);
  }
  return out;
}

async function main() {
  if (cmd === 'deployments') {
    const d = await checkoutDeployments();
    if (d.topicFrom === 'HCS_RECORDS_TOPIC_ID') d.recordsTopic = null;
    return console.log(JSON.stringify(d, null, 2)), 0;
  }
  if (cmd === 'preflight') return preflight();
  if (cmd === 'claim' && arg) return console.log(JSON.stringify(await claim(arg.toLowerCase()))), 0;
  if (cmd === 'order' && arg) return console.log(JSON.stringify(await order(arg.toLowerCase()))), 0;
  if (cmd === 'party' && arg) return console.log(JSON.stringify(await party(arg))), 0;
  console.error('usage: state.mjs deployments | preflight | claim <claimId> | order <orderId> | party <role>');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`state: ${safeText(e)}`);
    process.exit(1);
  },
);
