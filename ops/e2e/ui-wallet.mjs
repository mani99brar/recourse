#!/usr/bin/env node
// Drives the web app in Chromium with an injected EIP-1193 wallet. The page gets window.ethereum from an
// init script; every request it makes goes through page.exposeBinding to this Node process, which holds
// the account (and, in send mode, the role's signer) and the chain RPCs. No key ever enters the page.
//
//   node ui-wallet.mjs [--dry] [--flows pages,connect,withdraw,evidence,contest,file,next] [--web URL]
//   node ui-wallet.mjs --send --as <role> --flows <one flow> [--claim <claimId>] [--order <orderId>]
//
// --dry (the default): eth_sendTransaction is never broadcast. The wallet checks the request against
// the transaction the API built, simulates it (eth_call + eth_estimateGas as `from` on the chain's RPC),
// records what would be sent, and answers EIP-1193 4001 (declined), so the page stops on its own words.
// In dry mode the wallet can be any account (the role's address from deployments/parties.json): nothing
// is signed.
// --send: the wallet signs with the role's keystore in this process and broadcasts; the page waits for
// the receipt through the wallet and reads the new state back. Give exactly the flow to run.
//
// Each UI action: connect, fill the form, build; the preview on screen is checked against the API answer
// the page received and against a second build by this harness (same body); then confirm. Read-only pages
// are opened without a wallet. Screenshots at 1280 and 390 wide go to $E2E_RAW_DIR/shots/.
// Run under the suite lock with at least 1200 MB available (README). Playwright is not a dependency of
// this repo: E2E_PLAYWRIGHT_DIR names a node_modules/playwright folder (with its Chromium installed).

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Http, PUBLIC_RPC, RAW, Results, Rpc, TEST_CHAINS, argv, loadParties, loadRoleSigner, partyAddresses, readBackShows, safeText, sendBuilt, sleep, stamp, viem } from './lib.mjs';

const o = argv({ dry: 'bool', send: 'bool', as: 'str', flows: 'str', claim: 'str', order: 'str', web: 'str', out: 'str', 'hedera-rpc': 'str', 'arb-rpc': 'str', headed: 'bool', viewports: 'str' });
const WEB = (o.web ?? 'http://127.0.0.1:8788').replace(/\/$/, '');
const SEND = o.send === true;
if (SEND && (!o.as || !o.flows || o.flows.includes(','))) throw new Error('--send needs --as <role> and exactly one --flows <flow>');
const FLOWS = new Set((o.flows ?? 'pages,connect,withdraw,evidence,contest,file,next').split(','));
const SHOTS = join(RAW, 'shots');
mkdirSync(SHOTS, { recursive: true });
const res = new Results('ui', o.out ?? join(RAW, `ui-wallet-${stamp()}.jsonl`));
const api = new Http({ base: `${WEB}/api`, client: `e2e-ui-harness-${process.pid}` });
const rpcs = { 296: new Rpc(296, o['hedera-rpc'] ?? PUBLIC_RPC[296]), 421614: new Rpc(421614, o['arb-rpc'] ?? PUBLIC_RPC[421614]) };
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } };
const VPS = (o.viewports ?? 'desktop,mobile').split(',');
const PLAYWRIGHT = process.env.E2E_PLAYWRIGHT_DIR ? join(process.env.E2E_PLAYWRIGHT_DIR, 'index.mjs') : null;
if (!PLAYWRIGHT || !existsSync(PLAYWRIGHT)) {
  res.add({ path: 'UI (browser)', test: 'the web app in Chromium with an injected wallet', result: 'blocked', notes: [PLAYWRIGHT ? `no Playwright at ${PLAYWRIGHT}` : 'not run: E2E_PLAYWRIGHT_DIR unset (a node_modules/playwright folder)'] });
  process.exit(0);
}
const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
await loadParties();

const CHAIN_LABEL = (id) => `${TEST_CHAINS[id]} (chain ${id})`;
const RANDOM32 = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- the wallet: the page's half (an init script) and this process's half ----

const PROVIDER = `(() => {
  const listeners = {};
  const provider = {
    isE2eHarness: true,
    async request(args) {
      const r = await window.__e2eWallet({ method: args.method, params: args.params ?? [] });
      if (r.ok) return r.result;
      const e = new Error(r.error.message);
      e.code = r.error.code;
      if (r.error.data !== undefined) e.data = r.error.data;
      throw e;
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return provider; },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return provider; },
  };
  window.__e2eEmit = (ev, arg) => (listeners[ev] || []).forEach((f) => { try { f(arg); } catch {} });
  Object.defineProperty(window, 'ethereum', { value: provider, configurable: false, writable: false });
})();`;

const rpcError = (code, message, data) => ({ ok: false, error: { code, message, ...(data !== undefined ? { data } : {}) } });

class Wallet {
  constructor({ address, account, chainId = 296 }) {
    this.address = address;
    this.account = account ?? null;
    this.chainId = chainId;
    this.connected = false;
    this.calls = [];
    this.sends = [];
    this.page = null;
    // The transactions of the answer on screen; the wallet signs nothing else, at no more gas than built.
    this.allowed = [];
  }
  builtMatch(tx, value) {
    return this.allowed.find((b) => b.chainId === this.chainId && b.to.toLowerCase() === String(tx.to ?? '').toLowerCase() && b.data.toLowerCase() === String(tx.data ?? '').toLowerCase() && b.value === value) ?? null;
  }
  emit(ev, arg) {
    const p = this.page;
    if (p) setTimeout(() => void p.evaluate(([e, a]) => window.__e2eEmit?.(e, a), [ev, arg]).catch(() => undefined), 50);
  }
  async handle({ method, params }) {
    this.calls.push(method);
    try {
      switch (method) {
        case 'eth_requestAccounts':
          this.connected = true;
          return { ok: true, result: [this.address] };
        case 'eth_accounts':
          return { ok: true, result: this.connected ? [this.address] : [] };
        case 'eth_chainId':
          return { ok: true, result: viem.toHex(this.chainId) };
        case 'net_version':
          return { ok: true, result: String(this.chainId) };
        case 'wallet_requestPermissions':
        case 'wallet_getPermissions':
          return { ok: true, result: [{ parentCapability: 'eth_accounts' }] };
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain': {
          const id = Number(params?.[0]?.chainId);
          if (!(id in TEST_CHAINS)) return rpcError(4902, `chain ${id} is not one this wallet adds (test networks only)`);
          if (method === 'wallet_switchEthereumChain' && id !== this.chainId) this.emit('chainChanged', viem.toHex(id));
          this.chainId = id;
          return { ok: true, result: null };
        }
        case 'eth_sendTransaction':
          return await this.sendTransaction(params?.[0] ?? {});
        case 'personal_sign':
        case 'eth_sign':
        case 'eth_signTypedData':
        case 'eth_signTypedData_v3':
        case 'eth_signTypedData_v4':
          // The app never asks for a message signature; a request for one is recorded and declined.
          return rpcError(4001, 'This wallet signs no messages.');
        case 'eth_subscribe':
        case 'eth_unsubscribe':
          return rpcError(4200, `${method} is not supported`);
        default: {
          const rpc = rpcs[this.chainId];
          await rpc.guard();
          return { ok: true, result: await rpc.call(method, params ?? []) };
        }
      }
    } catch (e) {
      return rpcError(e.rpc?.code ?? -32603, safeText(e), e.rpc?.data);
    }
  }
  async sendTransaction(tx) {
    const rec = {
      chainId: this.chainId, from: tx.from, to: tx.to, data: tx.data, value: BigInt(tx.value ?? '0x0').toString(), gas: tx.gas ? BigInt(tx.gas).toString() : null,
      at: new Date().toISOString(),
    };
    this.sends.push(rec);
    if (!tx.from || tx.from.toLowerCase() !== this.address.toLowerCase()) return rpcError(4100, 'from is not this wallet\'s account');
    if (tx.chainId !== undefined && Number(tx.chainId) !== this.chainId) return rpcError(4901, 'the transaction is for another chain');
    const built = this.builtMatch(tx, rec.value);
    rec.built = built !== null && rec.gas !== null && BigInt(rec.gas) <= BigInt(built.gas);
    if (!SEND) {
      const sim = await rpcs[this.chainId].simulate({ from: tx.from, to: tx.to, data: tx.data, value: rec.value });
      rec.simulated = sim;
      return rpcError(4001, 'Declined by the e2e harness: dry run, nothing sent.');
    }
    if (!rec.built) return rpcError(4001, 'Declined by the e2e harness: not a transaction the API built for this action, or above its gas.');
    if (!this.account) return rpcError(4100, 'no signer loaded');
    const sent = await sendBuilt(this.account, rpcs[this.chainId], { chainId: this.chainId, to: tx.to, data: tx.data, value: rec.value, gas: rec.gas, gasPrice: '0' }, { wait: false });
    rec.hash = sent.hash;
    return { ok: true, result: sent.hash };
  }
}

// ---- pages ----

let browser;

async function openContext(vp, wallet) {
  const context = await browser.newContext({ viewport: VIEWPORTS[vp], deviceScaleFactor: 1 });
  // The tunnel sets this on every request it serves; here it gives the browser its own rate-limit bucket.
  // Only on /api: on the page's own cross-origin reads (Arkiv) it would fail their CORS preflight.
  const client = `e2e-ui-${vp}-${process.pid}`;
  await context.route((u) => u.origin === WEB && u.pathname.startsWith('/api/'), (route) => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': client } }));
  if (wallet) {
    await context.exposeBinding('__e2eWallet', (_source, req) => wallet.handle(req));
    await context.addInitScript(PROVIDER);
  }
  const page = await context.newPage();
  if (wallet) wallet.page = page;
  const log = { console: [], failed: [], api: [], actions: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') log.console.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => log.console.push(`pageerror: ${safeText(e)}`));
  page.on('requestfailed', (r) => log.failed.push(`${r.method()} ${new URL(r.url()).pathname}: ${r.failure()?.errorText}`));
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    log.api.push(`${r.request().method()} ${u.pathname} ${r.status()}`);
    if (u.pathname.startsWith('/api/v1/actions/') && r.request().method() === 'POST') {
      const body = await r.json().catch(() => null);
      log.actions.push({ name: u.pathname.split('/').pop(), status: r.status(), body, request: JSON.parse(r.request().postData() ?? 'null') });
    }
  });
  return { context, page, log };
}

async function shot(page, name, vp) {
  const file = join(SHOTS, `${name}-${vp}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return `raw/shots/${name}-${vp}.png`;
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page.locator('text=Loading').first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined);
}

const card = (page, title) => page.locator('section.card').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });

/** The page says it cannot reach the status service (its Banner): what it shows is not the API's answer. */
async function unreachableShown(page) {
  return (await page.locator('main .banner').allInnerTexts()).some((t) => /status service cannot be reached/.test(t));
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

function add(r) {
  return res.add(r);
}

// ---- what the API says, read by this harness itself ----

let state;
async function readState() {
  const get = async (p) => {
    let r;
    for (let i = 0; i < 4; i++) {
      r = await api.request('GET', p);
      if (r.status === 200) return r.json;
      await sleep(4000);
    }
    const e = new Error(`GET ${p} did not answer 200 (HTTP ${r.status}) in 4 tries`);
    e.upstream = [0, 502, 503].includes(r.status);
    throw e;
  };
  // The pages poll params themselves; this harness only needs the claims and parties.
  const params = (await get('/v1/params').catch(() => ({ params: null }))).params;
  const claims = (await get('/v1/claims')).claims;
  const details = {};
  for (const c of claims) details[c.claimId] = (await get(`/v1/claims/${c.claimId}`)).claim;
  const parties = partyAddresses();
  const credit = {};
  for (const role of ['shop', 'platform', 'scheme']) credit[role] = (await get(`/v1/parties/${parties[role]}`).catch(() => ({ party: { credit: null } }))).party.credit;
  state = { params, claims, details, parties, credit };
}

/** An API cross-check that rides out a status API that is briefly unreachable (502/503 upstream_unavailable). */
async function crossCheck(method, path, body) {
  let r;
  for (let i = 0; i < 3; i++) {
    r = await api.request(method, path, body ? { body } : {});
    if (![0, 502, 503].includes(r.status)) break;
    await sleep(5000);
  }
  return { ...r, unreachable: [0, 502, 503].includes(r.status) };
}

/** The same body built again by this harness, to compare with what the page received. */
async function buildAgain(name, body) {
  const r = await crossCheck('POST', `/v1/actions/${name}`, body);
  return r.status === 200 ? r.json : { error: r.json?.error ?? { code: `http_${r.status}` }, unreachable: r.unreachable };
}

function samePreview(a, b) {
  const out = [];
  for (const k of ['action', 'chain', 'chainId', 'from', 'claimId', 'readBack']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`${k}: page ${JSON.stringify(a[k])}, harness ${JSON.stringify(b[k])}`);
  if (a.transactions.length !== b.transactions.length) out.push('transaction count differs');
  a.transactions.forEach((t, i) => {
    const u = b.transactions[i];
    if (!u) return;
    for (const k of ['chainId', 'to', 'data', 'value', 'simulated']) if (String(t[k]).toLowerCase() !== String(u[k]).toLowerCase()) out.push(`tx ${i + 1} ${k} differs`);
    if (JSON.stringify(t.call) !== JSON.stringify(u.call)) out.push(`tx ${i + 1} call differs`);
    const g = Number(t.gas) / Number(u.gas);
    if (g < 0.75 || g > 1.33) out.push(`tx ${i + 1} gas ${t.gas} vs ${u.gas}`);
  });
  const amt = (x) => x.preview.amounts.map((m) => `${m.name}:${m.amount}:${m.decimals}:${m.symbol}:${m.movement}:${m.account}`).join('|');
  if (amt(a) !== amt(b)) out.push(`amounts: page ${amt(a)}; harness ${amt(b)}`);
  if (a.preview.statusAfter !== b.preview.statusAfter) out.push('statusAfter differs');
  if (a.preview.fee.symbol !== b.preview.fee.symbol || a.preview.fee.decimals !== b.preview.fee.decimals) out.push('fee unit differs');
  return out;
}

/** The preview on screen says what the API answer says: network, signer, amounts, fee, steps. */
async function screenMatches(c, resp) {
  const out = [];
  const pv = c.locator('.preview');
  const network = (await pv.locator('.kv', { has: c.page().locator('dt', { hasText: /^Network$/ }) }).locator('dd').innerText().catch(() => '')).trim();
  if (network !== CHAIN_LABEL(resp.chainId)) out.push(`Network shows "${network}", the answer is ${CHAIN_LABEL(resp.chainId)}`);
  const signer = await pv.locator('.kv', { has: c.page().locator('dt', { hasText: /^Signed by$/ }) }).locator('dd').innerText().catch(() => '');
  if (!signer.includes(resp.from)) out.push('Signed by does not show the account the answer was built for');
  const text = await pv.innerText();
  const fee = `At most ${viem.formatUnits(BigInt(resp.preview.fee.amount), resp.preview.fee.decimals)} ${resp.preview.fee.symbol}`;
  if (!text.includes(fee)) out.push(`fee line "${fee}" is not on screen`);
  const rows = await pv.locator('table tbody tr').count();
  if (resp.preview.amounts.length === 0 ? !text.includes('No money moves.') : rows !== resp.preview.amounts.length) out.push(`amount rows ${rows}, the answer has ${resp.preview.amounts.length}`);
  for (const [i, a] of resp.preview.amounts.entries()) {
    const cell = await pv.locator('table tbody tr').nth(i).locator('td').nth(1).innerText().catch(() => '');
    const shown = Number((cell.match(/[0-9][0-9,]*(\.[0-9]+)?/) ?? ['NaN'])[0].replace(/,/g, ''));
    const want = Number(viem.formatUnits(BigInt(a.amount), a.decimals));
    if (Math.abs(shown - want) > 1e-9 * Math.max(1, want)) out.push(`amount ${a.name}: screen "${cell}", answer ${want}`);
  }
  const steps = await pv.locator('ol.steps > li').count();
  if (steps !== resp.transactions.length) out.push(`steps listed ${steps}, the answer has ${resp.transactions.length}`);
  return out;
}

/**
 * One action through its card: build, check the preview, confirm. Dry: the wallet declines once it
 * has simulated; send: it broadcasts and the card reads the change back.
 */
async function runAction({ page, log, wallet, vp, title, name, flow, fill }) {
  const c = card(page, title);
  const path = `UI ${flow} ${name}`;
  // A panel shows once the page's reads answer; a slow or failing status API holds it back for a while.
  await c.first().waitFor({ timeout: 40_000 }).catch(() => undefined);
  if ((await c.count()) === 0) return { offered: false, unreachable: await unreachableShown(page) };
  if (await c.getByRole('button', { name: 'Connect wallet' }).count()) await c.getByRole('button', { name: 'Connect wallet' }).click();
  if (fill) await fill(c);
  const build = c.getByRole('button', { name: 'Show what this will do' });
  await build.waitFor({ timeout: 10_000 });
  if (await build.isDisabled()) {
    const why = await c.locator('p.error').allInnerTexts();
    add({ path, test: `${title}: build button disabled (${vp})`, result: 'fail', problems: why.length ? why : ['disabled with no reason shown'], shot: await shot(page, `${flow}-disabled`, vp) });
    return { offered: true };
  }
  // The answer is taken from the response itself: the log's copy is pushed only after its body is read,
  // which can land after the preview shows.
  const answered = page
    .waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/actions/${name}` && r.request().method() === 'POST', { timeout: 45_000 })
    .then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null), request: JSON.parse(r.request().postData() ?? 'null') }))
    .catch(() => null);
  await build.click();
  const got = await answered;
  await Promise.race([
    c.locator('.preview').waitFor({ timeout: 45_000 }),
    c.locator('p.error[role=alert]').waitFor({ timeout: 45_000 }),
  ]).catch(() => undefined);
  if (!got) {
    add({ path, test: `${title}: the page posted no ${name} (${vp})`, result: 'fail', shot: await shot(page, `${flow}-nopost`, vp) });
    return { offered: true };
  }
  if (got.status !== 200) {
    const shown = (await c.locator('p.error[role=alert]').innerText().catch(() => '')).trim();
    const code = got.body?.error?.code;
    const problems = [];
    if (!code) problems.push('the API answer carries no code');
    if (code && !shown.includes(`(${code})`)) problems.push(`the page does not show the code ${code}`);
    return { offered: true, refused: { code, shown, status: got.status, problems, request: got.request }, card: c };
  }
  const resp = got.body;
  const again = await buildAgain(name, got.request);
  // A second build the status API could not answer leaves that comparison undone, not failed.
  const partial = again.error && again.unreachable ? `the harness's own build answered ${again.error.code} after 3 tries: the page's preview was checked against its own answer only` : null;
  const problems = again.error ? (partial ? [] : [`the harness's own build answered ${again.error.code}`]) : samePreview(resp, again);
  problems.push(...(await screenMatches(c, resp)));
  const banner = await c.locator('.banner[role=alert]').allInnerTexts();
  if (banner.length) problems.push(`the page refuses to sign: ${banner.join(' ').slice(0, 300)}`);
  const previewShot = await shot(page, `${flow}-preview`, vp);
  const confirm = c.getByRole('button', { name: /^Confirm and sign/ });
  if (await confirm.isDisabled()) {
    add({ path, test: `${title}: preview (${vp})`, result: 'fail', problems: [...problems, 'confirm is disabled'], shot: previewShot });
    return { offered: true, resp };
  }
  const sendsBefore = wallet.sends.length;
  const callsBefore = wallet.calls.length;
  wallet.allowed = resp.transactions;
  await confirm.click();
  if (!SEND) {
    await c.locator('p.error[role=alert]').waitFor({ timeout: 60_000 }).catch(() => undefined);
    const stop = (await c.locator('p.error[role=alert]').innerText().catch(() => '')).trim();
    const sent = wallet.sends.slice(sendsBefore);
    const asked = wallet.calls.slice(callsBefore);
    const t0 = resp.transactions[0];
    let unsimulated = null;
    if (sent.length !== 1) problems.push(`the wallet got ${sent.length} eth_sendTransaction, expected 1 (the first step)`);
    const s = sent[0];
    if (s) {
      if (s.to?.toLowerCase() !== t0.to.toLowerCase() || s.data?.toLowerCase() !== t0.data.toLowerCase() || s.value !== t0.value) problems.push('the wallet was asked to send something other than the built transaction');
      if (s.gas !== t0.gas) problems.push(`gas sent ${s.gas}, built ${t0.gas}`);
      if (s.chainId !== t0.chainId) problems.push(`the wallet was on chain ${s.chainId} when asked, the step is for ${t0.chainId}`);
      if (s.simulated?.revert) problems.push(`simulation on ${TEST_CHAINS[s.chainId]} reverted: ${String(s.simulated.revert).slice(0, 120)}`);
      if (s.simulated?.unreachable) unsimulated = `the wallet could not simulate it: the ${TEST_CHAINS[s.chainId]} RPC did not answer (${s.simulated.unreachable})`;
      // The rule send mode signs by: a dry run proves it would let this transaction through.
      if (!s.built) problems.push('send mode would decline this transaction (not matched to the answer, or above its gas)');
    }
    if (!/declined in your wallet/i.test(stop) || !stop.includes('(rejected)')) problems.push(`after the decline the page says "${stop.slice(0, 160)}"`);
    if (asked.some((m) => /^(personal_sign|eth_sign)/.test(m))) problems.push('the page asked for a message signature');
    const undone = [partial, unsimulated].filter(Boolean);
    add({
      path, test: `${title}: preview, confirm, wallet asked, declined (${vp})`, result: problems.length ? 'fail' : undone.length ? 'blocked' : 'dry-only',
      ...(problems.length ? { problems } : {}),
      ...(undone.length ? { notes: undone } : {}),
      data: {
        chain: CHAIN_LABEL(resp.chainId), amounts: resp.preview.amounts.map((a) => `${a.name} ${a.display}`), fee: resp.preview.fee.display,
        walletCalls: [...new Set(asked)], simulatedGas: s?.simulated?.gas ?? null, builtGas: t0.gas, sendModeWouldSign: s?.built ?? null,
      },
      shot: `${previewShot} ${await shot(page, `${flow}-declined`, vp)}`,
    });
    return { offered: true, resp };
  }
  // Send: wait for the card to finish (read back or a stop), then report every hash the wallet sent.
  await c.locator('text=/Read back from the chain|Mined, but|p.error/').first().waitFor({ timeout: 300_000 }).catch(() => undefined);
  await Promise.race([c.getByText('Read back from the chain through the status service:').waitFor({ timeout: 200_000 }), c.locator('p.error[role=alert]').waitFor({ timeout: 200_000 })]).catch(() => undefined);
  const sent = wallet.sends.slice(sendsBefore);
  const hashes = sent.map((x) => x.hash).filter(Boolean);
  const ok = await c.getByText('Read back from the chain through the status service:').count();
  const stop = (await c.locator('p.error[role=alert]').innerText().catch(() => '')).trim();
  // The preview's problems found above count here too, then what the page says is checked on its own:
  // each receipt from the chain, then the API's read of the change.
  if (!ok) problems.push(stop || 'no read-back shown');
  if (sent.some((x) => !x.built)) problems.push('the page asked the wallet for a transaction the API did not build (declined)');
  if (hashes.length !== resp.transactions.length) problems.push(`${hashes.length} of ${resp.transactions.length} steps sent`);
  for (const x of sent.filter((y) => y.hash)) {
    const receipt = await rpcs[x.chainId].call('eth_getTransactionReceipt', [x.hash]).catch(() => null);
    if (receipt?.status !== '0x1') problems.push(`${x.hash}: receipt ${receipt ? `status ${receipt.status}` : 'not found'}`);
  }
  let after = null;
  for (let i = 0; hashes.length && i < 20; i++) {
    const rb = await api.request('GET', resp.readBack);
    if (rb.status === 200 && readBackShows(resp, rb.json, hashes)) {
      after = rb.json.claim ? `status ${rb.json.claim.statusKey}` : `credit ${rb.json.party.credit}`;
      break;
    }
    await sleep(3000);
  }
  if (hashes.length && !after) problems.push(`GET ${resp.readBack} did not show the change within 60 s`);
  const notes = [...(after ? [`API read back: ${after}`] : []), ...(partial ? [partial] : [])];
  add({ path, test: `${title}: signed, mined, read back (${vp})`, result: problems.length ? 'fail' : 'pass', txHash: hashes.join(' '), ...(problems.length ? { problems } : {}), ...(notes.length ? { notes } : {}), shot: await shot(page, `${flow}-done`, vp) });
  return { offered: true, resp, hashes };
}

// ---- flows ----

async function pagesFlow(vp) {
  const { claims, parties } = state;
  const list = [
    ['home', '#/', async (p) => (await p.locator('section.card').filter({ has: p.getByRole('heading', { name: 'Latest claims' }) }).locator('ul.claims > li').count()) === Math.min(20, claims.length) ? [] : ['Latest claims does not list every claim']],
    ...claims.map((c) => [`claim-${c.claimId.slice(2, 10)}`, `#/claim/${c.claimId}`, async (p) => {
      const out = [];
      const pill = (await p.locator('.case-head h1 .pill').innerText().catch(() => '')).trim();
      if (!pill) out.push('no status shown');
      if ((await p.locator('ol.timeline > li').count()) !== 7) out.push('timeline does not have its seven steps');
      if (await p.getByRole('button', { name: 'Confirm and sign in your wallet' }).count()) out.push('a confirm button shows without a wallet');
      return out;
    }]),
    ['party-shop', `#/party/${parties.shop}`, async (p) => ((await p.getByText('Credit to withdraw').count()) ? [] : ['no credit row'])],
    ['docket', '#/docket', async (p) => ((await p.locator('section.card').count()) ? [] : ['no docket card'])],
    ['file', '#/file', async (p) => ((await p.getByRole('heading', { name: 'Check an order before filing' }).count()) ? [] : ['no file heading'])],
  ];
  const { context, page, log } = await openContext(vp, null);
  try {
    for (const [name, hash, check] of list) {
      const before = { c: log.console.length, f: log.failed.length, a: log.api.length };
      await page.goto(`${WEB}/${hash}`);
      await settle(page);
      // The pages poll every 5 s: a read that failed once gets another chance before the check counts.
      // A page that still says it cannot reach the status service shows no figures to check.
      const unreachable = async () => ((await unreachableShown(page)) ? ['the page says the status service cannot be reached'] : []);
      const look = async () => [...(await check(page)), ...(await unreachable())];
      let problems = await look();
      for (let i = 0; problems.length && i < 6; i++) {
        await sleep(5000);
        problems = await look();
      }
      if (await page.locator('header.top .wallet').count()) problems.push('the header shows a wallet control with no wallet in the browser');
      const over = await overflow(page);
      if (over > 1) problems.push(`the page is ${over}px wider than the ${VIEWPORTS[vp].width}px viewport`);
      const upstream = log.api.slice(before.a).filter((x) => / 50[23]$/.test(x));
      const errs = log.console.slice(before.c).filter((x) => !(upstream.length && /status of 50[23]/.test(x)));
      if (errs.length) problems.push(`console: ${errs.slice(0, 3).join(' | ')}`);
      const failed = log.failed.slice(before.f).filter((x) => !/net::ERR_ABORTED/.test(x));
      if (failed.length) problems.push(`failed requests: ${failed.slice(0, 3).join(' | ')}`);
      const banner = (await page.locator('main .banner').allInnerTexts()).join('\n').split('\n').find((l) => /status service/.test(l)) ?? null;
      const notes = upstream.length ? [`API answered ${[...new Set(upstream)].slice(0, 4).join(', ')} while this page loaded; the page said: ${banner ?? 'nothing about it'}`] : [];
      // Content missing only because an API read timed out upstream is an outage, not a page fault.
      const result = problems.length === 0 ? 'pass' : upstream.length && errs.length === 0 && failed.length === 0 && banner ? 'blocked' : 'fail';
      add({ path: `UI ${hash.replace(/0x[0-9a-fA-F]+/, '{id}')} (no wallet)`, test: `${name} reads without a wallet (${vp})`, result, ...(problems.length ? { problems } : {}), ...(notes.length ? { notes } : {}), shot: await shot(page, `page-${name}`, vp) });
    }
  } finally {
    await context.close();
  }
}

async function withWallet(vp, address, account, fn) {
  const wallet = new Wallet({ address, account });
  const ctx = await openContext(vp, wallet);
  try {
    return await fn({ ...ctx, wallet });
  } finally {
    await ctx.context.close();
  }
}

async function connectFlow(vp) {
  await withWallet(vp, state.parties.shop, null, async ({ page, wallet }) => {
    await page.goto(`${WEB}/#/`);
    await settle(page);
    const btn = page.locator('header.top .wallet button', { hasText: 'Connect wallet' });
    const problems = [];
    if (!(await btn.count())) problems.push('no Connect wallet in the header with a wallet present');
    else await btn.click();
    await page.locator('header.top .wallet a.mono').waitFor({ timeout: 10_000 }).catch(() => undefined);
    const shown = (await page.locator('header.top .wallet').innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (!wallet.calls.includes('eth_requestAccounts')) problems.push('the page never asked eth_requestAccounts');
    if (!/Hedera testnet/.test(shown)) problems.push(`header shows "${shown}", expected the network name`);
    const link = await page.locator('header.top .wallet a.mono').getAttribute('href').catch(() => null);
    if (link !== `#/party/${state.parties.shop}`) problems.push(`account link ${link}`);
    add({ path: 'UI header Connect wallet', test: `connect: eth_requestAccounts, account and network in the header (${vp})`, result: problems.length ? 'fail' : 'pass', ...(problems.length ? { problems } : {}), data: { header: shown, walletCalls: [...new Set(wallet.calls)] }, shot: await shot(page, 'connect', vp) });
  });
}

async function withdrawFlow(vp, account) {
  const { parties, credit } = state;
  // Dry: the account with credit to withdraw (nothing is signed, so it need not be one whose key is here).
  // A credit this harness could not read (an outage) is tried before one known to be zero, so an outage
  // during the first read does not quietly turn the flow into "nothing to withdraw".
  const roles = ['shop', 'platform', 'scheme'];
  const role = SEND ? o.as : roles.find((r) => credit[r] != null && BigInt(credit[r]) > 0n) ?? roles.find((r) => credit[r] == null) ?? 'shop';
  const address = account?.address ?? parties[role];
  await withWallet(vp, address, account, async ({ page, log, wallet }) => {
    wallet.connected = true;
    await page.goto(`${WEB}/#/party/${address}`);
    await settle(page);
    const r = await runAction({ page, log, wallet, vp, title: 'Withdraw credit', name: 'withdrawCredit', flow: `withdraw-${role}` });
    if (!r.offered) {
      const party = await crossCheck('GET', `/v1/parties/${address}`);
      const again = await crossCheck('POST', '/v1/actions/withdrawCredit', { from: address });
      const agrees = party.json?.party?.credit === '0' && again.json?.error?.code === 'no_credit';
      const unsure = party.unreachable || again.unreachable || r.unreachable;
      const notes = [...(party.unreachable || again.unreachable ? ['the status API was unreachable for the cross-check'] : []), ...(r.unreachable ? ['the page said the status service cannot be reached'] : [])];
      add({ path: 'UI withdraw withdrawCredit', test: `withdraw panel not offered for ${role} (credit ${party.json?.party?.credit}); the API answers ${again.json?.error?.code ?? again.status} (${vp})`, result: agrees || unsure ? 'blocked' : 'fail', ...(notes.length ? { notes } : {}), shot: await shot(page, `withdraw-${role}-absent`, vp) });
    } else if (r.refused) {
      add({ path: 'UI withdraw withdrawCredit', test: `withdraw refused ${r.refused.code}, shown with its code (${vp})`, result: r.refused.problems.length ? 'fail' : 'pass', ...(r.refused.problems.length ? { problems: r.refused.problems } : {}), shot: await shot(page, `withdraw-${role}-refused`, vp) });
    }
  });
}

function claimWith(pred) {
  if (o.claim) return state.details[o.claim.toLowerCase()] ?? null;
  return Object.values(state.details).find(pred) ?? null;
}

async function evidenceFlow(vp, account) {
  const d = claimWith((x) => (x.court?.disputeIds ?? []).length > 0);
  if (!d) {
    add({ path: 'UI claim submitEvidence', test: `no claim with a court dispute: evidence form not shown (${vp})`, result: 'blocked' });
    return;
  }
  const address = account?.address ?? state.parties['ops-arb'];
  await withWallet(vp, address, account, async ({ page, log, wallet }) => {
    wallet.connected = true;
    await page.goto(`${WEB}/#/claim/${d.claimId}`);
    await settle(page);
    const r = await runAction({
      page, log, wallet, vp, title: 'Add evidence to the court case', name: 'submitEvidence', flow: `evidence-${d.claimId.slice(2, 10)}`,
      fill: async (c) => {
        await c.locator('#ev-name').fill(SEND ? 'Test round evidence' : 'Harness check: evidence preview');
        await c.locator('#ev-text').fill(SEND ? 'Added during the testnet test round.' : 'Built by the e2e harness in dry mode; the wallet declines, nothing is sent.');
      },
    });
    if (!r.offered) add({ path: 'UI claim submitEvidence', test: `evidence form missing on a claim with dispute ${d.court.disputeIds[0]} (${vp})`, result: r.unreachable ? 'blocked' : 'fail', ...(r.unreachable ? { notes: ['the page said the status service cannot be reached'] } : {}), shot: await shot(page, 'evidence-absent', vp) });
    else if (r.refused) add({ path: 'UI claim submitEvidence', test: `evidence refused ${r.refused.code} (${vp})`, result: r.refused.problems.length ? 'fail' : 'pass', problems: r.refused.problems, shot: await shot(page, 'evidence-refused', vp) });
    if (r.resp && !SEND && !wallet.calls.includes('wallet_switchEthereumChain') && r.resp.chainId !== 296) {
      add({ path: 'UI claim submitEvidence', test: `the page did not ask the wallet to switch to ${CHAIN_LABEL(r.resp.chainId)} (${vp})`, result: 'fail' });
    }
  });
}

/** Why a claim found open to contest at discovery no longer is (read from the API now), or null if it still is. */
async function leftContest(claimId) {
  const r = await crossCheck('GET', `/v1/claims/${claimId}`);
  const c = r.json?.claim;
  return c && c.nextCall !== 'contest' ? `the claim left contest during the run: now ${c.statusKey}, next ${c.nextCall ?? 'none'}` : null;
}

async function contestFlow(vp, account) {
  const d = claimWith((x) => x.nextCall === 'contest');
  if (!d) {
    // Every claim is past contest: the panel must not show, and the API must refuse the call.
    const any = Object.values(state.details)[0];
    if (!any) return;
    await withWallet(vp, state.parties.shop, null, async ({ page, wallet }) => {
      wallet.connected = true;
      await page.goto(`${WEB}/#/claim/${any.claimId}`);
      await settle(page);
      // "Not shown" counts only once the claim itself has loaded (its status pill), not on an empty page.
      const loaded = await page.locator('.case-head h1 .pill').first().waitFor({ timeout: 40_000 }).then(() => true, () => false);
      const shown = await card(page, 'Contest the finding').count();
      const again = await crossCheck('POST', '/v1/actions/contest', { from: state.parties.shop, claimId: any.claimId });
      // Not shown and refused: there is nothing to contest, so the flow is blocked, not broken.
      const ok = loaded && shown === 0 && (again.json?.error?.code === 'wrong_status' || again.unreachable);
      const problems = [...(shown ? ['the contest panel shows on a claim past contest'] : []), ...(loaded ? [] : ['the claim page did not load, so the panel could not be looked for'])];
      add({
        path: 'UI claim contest', test: `contest not offered on ${any.claimId.slice(0, 10)} (${any.statusKey}); the API answers ${again.json?.error?.code ?? again.status} (${vp})`,
        result: ok || (!loaded && !shown && (await unreachableShown(page))) ? 'blocked' : 'fail',
        ...(problems.length ? { problems } : {}),
        ...(again.unreachable ? { notes: [`the status API was unreachable for the cross-check (${again.status} after 3 tries)`] } : {}),
        shot: await shot(page, 'contest-absent', vp),
      });
    });
    return;
  }
  const contester = d.answer === 1 ? d.platform : d.shop;
  const address = account?.address ?? contester;
  await withWallet(vp, address, account, async ({ page, log, wallet }) => {
    wallet.connected = true;
    await page.goto(`${WEB}/#/claim/${d.claimId}`);
    await settle(page);
    const r = await runAction({ page, log, wallet, vp, title: 'Contest the finding', name: 'contest', flow: `contest-${d.claimId.slice(2, 10)}` });
    if (!r.offered) {
      // The window may have closed since discovery: then the panel is rightly gone and the path is not testable.
      const left = await leftContest(d.claimId);
      add({ path: 'UI claim contest', test: `Contest the finding: preview, confirm, wallet asked, declined (${vp})`, result: left || r.unreachable ? 'blocked' : 'fail', ...(left || r.unreachable ? { notes: [left ?? 'the page said the status service cannot be reached'] } : { problems: ['the contest panel is missing on a claim whose next call is contest'] }), shot: await shot(page, 'contest-absent', vp) });
    }
    if (r.refused) add({ path: 'UI claim contest', test: `contest refused ${r.refused.code} (${vp})`, result: r.refused.problems.length ? 'fail' : 'pass', problems: r.refused.problems, shot: await shot(page, 'contest-refused', vp) });
  });
  // The other side sees why it cannot contest, and its build button stays off.
  if (!SEND) {
    const other = contester === d.shop ? d.platform : d.shop;
    await withWallet(vp, other, null, async ({ page, wallet }) => {
      wallet.connected = true;
      await page.goto(`${WEB}/#/claim/${d.claimId}`);
      await settle(page);
      const c = card(page, 'Contest the finding');
      const shown = await c.count();
      const warned = await c.getByText('This must be signed by').count();
      const disabled = await c.getByRole('button', { name: 'Show what this will do' }).isDisabled().catch(() => false);
      const left = shown ? null : await leftContest(d.claimId);
      const problems = shown ? [...(warned ? [] : ['no "This must be signed by" on the panel']), ...(disabled ? [] : ['the build button is not disabled'])] : left ? [] : ['the contest panel is missing'];
      add({ path: 'UI claim contest', test: `the side that may not contest is told so and cannot build (${vp})`, result: left ? 'blocked' : problems.length ? 'fail' : 'pass', ...(left ? { notes: [left] } : {}), ...(problems.length ? { problems } : {}), shot: await shot(page, 'contest-wrong-signer', vp) });
    });
  }
}

async function fileFlow(vp, account) {
  const address = account?.address ?? state.parties.shop;
  await withWallet(vp, address, account, async ({ page, log, wallet }) => {
    wallet.connected = true;
    // An order that already has a claim: the page links it and offers no filing.
    const claimed = state.claims[0];
    if (claimed && !SEND) {
      await page.goto(`${WEB}/#/file`);
      await settle(page);
      await page.locator('#oid').fill(claimed.orderId);
      await page.getByRole('button', { name: 'Load records' }).click();
      await page.getByText('This order already has a claim').waitFor({ timeout: 30_000 }).catch(() => undefined);
      const linked = await page.locator(`a[href="#/claim/${claimed.claimId}"]`).count();
      const panel = await card(page, '4. File the claim').count();
      add({ path: 'UI #/file fileClaim', test: `a claimed order links its claim and offers no filing (${vp})`, result: linked && !panel ? 'pass' : 'fail', shot: await shot(page, 'file-claimed', vp) });
    }
    const orderId = o.order ?? RANDOM32();
    await page.goto(`${WEB}/#/file`);
    await settle(page);
    await page.locator('#oid').fill(orderId);
    await page.getByRole('button', { name: 'Load records' }).click();
    await card(page, '4. File the claim').waitFor({ timeout: 30_000 }).catch(() => undefined);
    const r = await runAction({ page, log, wallet, vp, title: '4. File the claim', name: 'fileClaim', flow: 'file' });
    if (!r.offered) {
      add({ path: 'UI #/file fileClaim', test: `no filing panel for order ${orderId.slice(0, 10)} (${vp})`, result: r.unreachable ? 'blocked' : 'fail', ...(r.unreachable ? { notes: ['the page said the status service cannot be reached'] } : {}), shot: await shot(page, 'file-absent', vp) });
      return;
    }
    if (!r.refused) return;
    const first = r.refused;
    add({ path: 'UI #/file fileClaim', test: `unknown order: refused ${first.code}, shown with its code (${vp})`, result: first.problems.length ? 'fail' : SEND ? 'fail' : 'pass', ...(first.problems.length ? { problems: first.problems } : {}), shot: await shot(page, 'file-refused-1', vp) });
    if (first.code !== 'order_nonce_unknown') return;
    // The page then asks for the nonce and the agent company: with a nonce that was never paid, no record.
    const c = card(page, '4. File the claim');
    const box = c.locator('input[type=checkbox]').first();
    if (!(await box.isChecked())) await box.check();
    await c.locator('#fc-nonce').fill(RANDOM32());
    await c.locator('#fc-plat').fill(state.parties.platform);
    const again = await runAction({ page, log, wallet, vp, title: '4. File the claim', name: 'fileClaim', flow: 'file-nonce' });
    if (again.refused) {
      const okCode = ['no_ordered_record', 'order_id_mismatch'].includes(again.refused.code);
      add({ path: 'UI #/file fileClaim', test: `nonce + agent company with no ordered record: refused ${again.refused.code} (${vp})`, result: again.refused.problems.length || !okCode ? 'fail' : 'pass', ...(again.refused.problems.length ? { problems: again.refused.problems } : {}), shot: await shot(page, 'file-refused-2', vp) });
    }
  });
}

const NEXT_TITLES = {
  closeUncontested: 'Close the claim', sendToCourt: 'Send the claim to court', resend: 'Resend the message to court', expireClaim: 'End the claim',
  settle: 'Settle the claim', openCase: 'Open the court case', refile: 'File the court case again', relayRuling: 'Send the ruling back to Hedera',
};

async function nextFlow(vp, account) {
  const d = claimWith((x) => x.nextCall in NEXT_TITLES);
  if (!d) {
    add({ path: 'UI claim next step (anyone)', test: `no claim has an anyone-may step due: nothing offered (${vp})`, result: 'blocked' });
    return;
  }
  const name = d.nextCall;
  const address = account?.address ?? state.parties[name === 'openCase' || name === 'refile' || name === 'relayRuling' ? 'ops-arb' : 'ops-hedera'];
  await withWallet(vp, address, account, async ({ page, log, wallet }) => {
    wallet.connected = true;
    await page.goto(`${WEB}/#/claim/${d.claimId}`);
    await settle(page);
    const r = await runAction({ page, log, wallet, vp, title: NEXT_TITLES[name], name, flow: `next-${name}` });
    if (r.refused) add({ path: `UI claim ${name}`, test: `${name} refused ${r.refused.code} (${vp})`, result: r.refused.problems.length ? 'fail' : 'pass', problems: r.refused.problems, shot: await shot(page, `next-${name}-refused`, vp) });
  });
}

async function main() {
  try {
    await readState();
  } catch (e) {
    if (!e.upstream) throw e;
    add({ path: 'UI (browser)', test: 'the web app in Chromium with an injected wallet', result: 'blocked', notes: [`not run: ${safeText(e)}; the status API could not serve the claims to test with`] });
    return 0;
  }
  let account = null;
  if (SEND) {
    account = await loadRoleSigner(o.as);
    const want = partyAddresses()[o.as];
    if (want && want !== account.address) throw new Error(`the ${o.as} key is ${account.address}; deployments/parties.json says ${want}`);
  }
  browser = await chromium.launch({ headless: !o.headed });
  try {
    for (const vp of SEND ? ['desktop'] : VPS) {
      if (FLOWS.has('pages')) await pagesFlow(vp);
      if (FLOWS.has('connect')) await connectFlow(vp);
      if (FLOWS.has('withdraw')) await withdrawFlow(vp, account);
      if (FLOWS.has('evidence')) await evidenceFlow(vp, account);
      if (FLOWS.has('contest')) await contestFlow(vp, account);
      if (FLOWS.has('file')) await fileFlow(vp, account);
      if (FLOWS.has('next')) await nextFlow(vp, account);
    }
  } finally {
    await browser.close();
  }
  return res.rows.some((r) => r.result === 'fail') ? 1 : 0;
}

main().then(
  (code) => {
    console.error(`\n${res.table()}\n\nresults: ${res.file}\nscreenshots: ${SHOTS}`);
    process.exit(code);
  },
  async (e) => {
    console.error(`ui-wallet: ${safeText(e)}`);
    await browser?.close().catch(() => undefined);
    if (res.rows.length) console.error(`\n${res.table()}`);
    process.exit(1);
  },
);
