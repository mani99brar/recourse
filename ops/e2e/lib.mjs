// Shared pieces of the e2e harness: the repo's own modules and loaders (the deployments, the party map,
// the records topic, the keystore), the OpenAPI checks, a paced HTTP client, read-only chain calls and
// the test-table output.
//
// Nothing here prints a key, a password, a keystore path or an env value. Errors that may carry an RPC
// URL are cut to the URL's scheme and host before they are printed.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = process.env.RECOURSE_REPO ?? resolve(HERE, '../..');
/** Where a part writes its JSON lines and screenshots: run.sh sets E2E_RAW_DIR to results/<label>/raw. */
export const RAW = process.env.E2E_RAW_DIR ?? join(HERE, 'results', 'adhoc', 'raw');
export const DEPLOYMENTS_DIR = process.env.DEPLOYMENTS_DIR || join(REPO, 'deployments');

let tsxOn = false;
/** Imports one of the repo's TypeScript modules (its loaders) through tsx. */
export async function repoModule(rel) {
  if (!tsxOn) {
    const { register } = await import(pathToFileURL(join(REPO, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
    register();
    tsxOn = true;
  }
  return import(pathToFileURL(join(REPO, rel)).href);
}

// viem is not hoisted to the root node_modules; the status API's copy is the one the API itself runs.
const repoRequire = createRequire(join(REPO, 'services/status-api/package.json'));
export const viem = repoRequire('viem');
export const viemAccounts = repoRequire('viem/accounts');

function ajvClass() {
  const store = join(REPO, 'node_modules/.pnpm');
  const dir = readdirSync(store).find((n) => /^ajv@8\./.test(n));
  if (!dir) throw new Error('ajv 8 is not in the repo node_modules');
  return createRequire(join(store, dir, 'node_modules/ajv/package.json'))('./dist/2020.js').default;
}

// ---- test table ----

export const TEST_CHAINS = Object.freeze({ 296: 'Hedera testnet', 421614: 'Arbitrum Sepolia' });
export const PUBLIC_RPC = Object.freeze({ 296: 'https://testnet.hashio.io/api', 421614: 'https://sepolia-rollup.arbitrum.io/rpc' });

/** An error's first line with any URL cut to its scheme and host (keyed RPC URLs carry the key in the path). */
export function safeText(e) {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0].replace(/\b(https?|wss?):\/\/([^/\s"'?#]+)[^\s"']*/g, '$1://$2/…').slice(0, 300);
}

/** One JSON line per check on stdout and in the results file; `rows` keeps them for the table. */
export class Results {
  constructor(suite, file) {
    this.suite = suite;
    this.file = file;
    this.rows = [];
    mkdirSync(dirname(file), { recursive: true });
  }
  add(r) {
    const row = { t: new Date().toISOString(), suite: this.suite, ...r };
    this.rows.push(row);
    const line = JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    console.log(line);
    appendFileSync(this.file, line + '\n');
    return row;
  }
  /** The operator's table: path, result, transaction hash or test name. */
  table() {
    return testTable(this.rows);
  }
}

/** Rows of any suite as the one table the operator reads (results.mjs merges a run's files with it). */
export function testTable(rows) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = '| Path | Result | Tx hash or test name | Note |\n|---|---|---|---|';
  const lines = rows.map((r) => `| ${cell(r.path)} | ${r.result}${r.code ? ` (${r.code})` : ''} | ${cell(r.txHash ? `${r.txHash} (${r.test})` : r.test)} | ${cell(rowNote(r))} |`);
  const count = (k) => rows.filter((r) => r.result === k).length;
  const tally = `pass ${count('pass')}, fail ${count('fail')}, blocked ${count('blocked')}, dry-only ${count('dry-only')}`;
  return `${head}\n${lines.join('\n')}\n\n${tally}`;
}

/** A row's problems, then its notes, as one short line. */
export function rowNote(r) {
  const parts = [...(r.problems ?? []), ...(r.notes ?? [])].map(String).filter(Boolean);
  const text = parts.join('; ');
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function argv(spec) {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (!k.startsWith('--')) throw new Error(`unexpected argument ${k}`);
    const name = k.slice(2);
    if (!(name in spec)) throw new Error(`unknown option ${k}`);
    if (spec[name] === 'bool') out[name] = true;
    else {
      if (a[i + 1] === undefined) throw new Error(`${k} needs a value`);
      out[name] = a[++i];
    }
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---- OpenAPI ----

const ptr = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** The served OpenAPI document as checks: response schemas by JSON pointer, codes per operation, code statuses. */
export class Spec {
  constructor(doc) {
    this.doc = doc;
    const Ajv = ajvClass();
    // OpenAPI 3.1 schema objects are JSON Schema 2020-12; x-recourse-* and examples are not keywords.
    this.ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    this.ajv.addSchema(doc, 'openapi');
    this.cache = new Map();
    this.codeStatus = new Map((doc['x-recourse-error-codes'] ?? []).map((c) => [c.code, c.status]));
    this.codes = new Set(doc.components?.schemas?.ErrorCode?.enum ?? []);
  }
  op(method, template) {
    return this.doc.paths?.[template]?.[method.toLowerCase()] ?? null;
  }
  /** The JSON pointer of the response schema for `status`, following a components/responses ref. */
  responsePointer(method, template, status) {
    const op = this.op(method, template);
    if (!op) return null;
    const key = String(status) in (op.responses ?? {}) ? String(status) : 'default' in (op.responses ?? {}) ? 'default' : null;
    if (key === null) return null;
    const r = op.responses[key];
    if (r.$ref) return `${r.$ref}/content/application~1json/schema`;
    if (!r.content?.['application/json']?.schema) return '';
    return `#/paths/${ptr(template)}/${method.toLowerCase()}/responses/${key}/content/application~1json/schema`;
  }
  validator(pointer) {
    if (!this.cache.has(pointer)) this.cache.set(pointer, this.ajv.compile({ $ref: `openapi${pointer}` }));
    return this.cache.get(pointer);
  }
  validate(pointer, value) {
    const v = this.validator(pointer);
    const ok = v(value);
    return ok ? [] : (v.errors ?? []).slice(0, 6).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}${e.params?.allowedValues ? ` ${JSON.stringify(e.params.allowedValues)}` : ''}`);
  }
  resolve(ref) {
    let node = this.doc;
    for (const part of ref.replace(/^#\//, '').split('/')) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return node;
  }
  /** Fields the answer holds that the schema does not declare (spec drift; clients ignore them). */
  undeclared(pointer, value, at = '', out = [], depth = 0) {
    if (depth > 12 || value === null || typeof value !== 'object' || out.length > 20) return out;
    const parts = this.flatten(pointer === '' ? {} : this.resolve(pointer), value);
    if (Array.isArray(value)) {
      const items = parts.items;
      if (items) for (const [i, v] of value.slice(0, 3).entries()) this.undeclared(items, v, `${at}[${i}]`, out, depth + 1);
      return out;
    }
    if (!parts.typed) return out;
    for (const [k, v] of Object.entries(value)) {
      if (parts.props.has(k)) this.undeclared(parts.props.get(k), v, `${at}.${k}`, out, depth + 1);
      else if (!parts.open) out.push(`${at}.${k}`);
    }
    return out;
  }
  /** Properties declared by a schema with its $ref, allOf and the anyOf branch that fits, as pointers. */
  flatten(schema, value, seen = 0) {
    const acc = { props: new Map(), open: false, typed: false, items: null };
    const walk = (s, base, n) => {
      if (!s || typeof s !== 'object' || n > 20) return;
      if (s.$ref) walk(this.resolve(s.$ref), s.$ref, n + 1);
      if (s.properties) {
        acc.typed = true;
        for (const k of Object.keys(s.properties)) if (!acc.props.has(k)) acc.props.set(k, `${base}/properties/${ptr(k)}`);
      }
      if (s.additionalProperties !== undefined && s.additionalProperties !== false) acc.open = true;
      if (s.patternProperties) acc.open = true;
      if (s.items && !acc.items) acc.items = `${base}/items`;
      for (const [i, sub] of (s.allOf ?? []).entries()) walk(sub, `${base}/allOf/${i}`, n + 1);
      for (const key of ['anyOf', 'oneOf']) {
        const branches = s[key] ?? [];
        const fit = branches.findIndex((b, i) => this.validator(`${base}/${key}/${i}`)(value));
        if (fit >= 0) walk(branches[fit], `${base}/${key}/${fit}`, n + 1);
      }
    };
    walk(schema, this.pointerOf(schema), seen);
    return acc;
  }
  pointerOf(schema) {
    // flatten() is entered with a resolved node; find its pointer once by identity (small document walk).
    if (!this._ptrs) {
      this._ptrs = new Map();
      const visit = (node, p) => {
        if (!node || typeof node !== 'object' || this._ptrs.has(node)) return;
        this._ptrs.set(node, p);
        for (const [k, v] of Object.entries(node)) visit(v, `${p}/${ptr(k)}`);
      };
      visit(this.doc, '#');
    }
    return this._ptrs.get(schema) ?? '#';
  }
}

// ---- HTTP, paced like a polite agent ----

export class Http {
  /** `client` goes out as cf-connecting-ip: what the tunnel sets, so this run counts as its own client. */
  constructor({ base, client, actionGapMs = 2100, readGapMs = 250 }) {
    this.base = base.replace(/\/$/, '');
    this.client = client;
    this.actionGapMs = actionGapMs;
    this.readGapMs = readGapMs;
    this.last = { action: 0, read: 0 };
    this.seen429 = 0;
  }
  async request(method, path, { body, raw, headers = {}, timeoutMs = 30_000, retries = 3, pace = true, client } = {}) {
    const isAction = method === 'POST';
    if (pace) {
      const gap = isAction ? this.actionGapMs : this.readGapMs;
      const kind = isAction ? 'action' : 'read';
      const wait = this.last[kind] + gap - Date.now();
      if (wait > 0) await sleep(wait);
      this.last[kind] = Date.now();
    }
    const h = { accept: 'application/json', 'cf-connecting-ip': client ?? this.client, ...headers };
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = h['content-type'] ?? 'application/json';
    }
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { status: 0, headers: {}, text: '', json: null, ms: Date.now() - t0, error: safeText(e) };
    }
    const text = await r.text();
    const ms = Date.now() - t0;
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    const hdrs = Object.fromEntries(r.headers.entries());
    if (r.status === 429 && retries > 0) {
      this.seen429++;
      const after = Math.min(Number(hdrs['retry-after'] ?? 2) || 2, 30);
      await sleep(after * 1000 + 250);
      return this.request(method, path, { body, raw, headers, timeoutMs, retries: retries - 1, pace: false, client });
    }
    return { status: r.status, headers: hdrs, text, json, ms };
  }
}

// ---- chains: read-only JSON-RPC, test networks only ----

export class Rpc {
  constructor(chainId, url) {
    if (!(chainId in TEST_CHAINS)) throw new Error(`chain ${chainId} is not a test network this harness uses`);
    this.chainId = chainId;
    this.url = url ?? PUBLIC_RPC[chainId];
    this.checked = false;
    this.id = 0;
  }
  async call(method, params = [], timeoutMs = 30_000) {
    const r = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`${TEST_CHAINS[this.chainId]} RPC answered HTTP ${r.status} with no JSON`);
    if (j.error) {
      const e = new Error(`${method}: ${j.error.message ?? 'error'}`);
      e.rpc = j.error;
      throw e;
    }
    return j.result;
  }
  /** Refuses any RPC that does not serve the expected test chain: nothing is ever sent elsewhere. */
  async guard() {
    if (this.checked) return;
    const served = Number(await this.call('eth_chainId'));
    if (served !== this.chainId) throw new Error(`the RPC serves chain ${served}, not ${this.chainId}; stopping`);
    this.checked = true;
  }
  /**
   * eth_call and eth_estimateGas as `from` at the latest block: what a wallet would see before signing.
   * A JSON-RPC error is the chain's answer (`revert`); no answer at all (an HTTP error, a timeout, a
   * refused connection) is `unreachable`: the RPC was down, which says nothing about the transaction.
   */
  async simulate(tx) {
    const out = { call: null, gas: null, revert: null, unreachable: null };
    const failed = (e) => {
      if (e.rpc) out.revert = e.rpc.data ?? safeText(e);
      else out.unreachable = safeText(e);
      return out;
    };
    try {
      await this.guard();
    } catch (e) {
      return failed(e);
    }
    const req = { from: tx.from, to: tx.to, data: tx.data, value: viem.toHex(BigInt(tx.value ?? 0)) };
    try {
      out.call = await this.call('eth_call', [req, 'latest']);
    } catch (e) {
      return failed(e);
    }
    try {
      out.gas = BigInt(await this.call('eth_estimateGas', [req])).toString();
    } catch (e) {
      failed(e);
    }
    return out;
  }
}

// ---- the calls the API may build, decoded with the generated ABIs ----

const abiFile = (n) => JSON.parse(readFileSync(join(REPO, 'deployments/abi', `${n}.json`), 'utf8'));
export const CALL_ABIS = {
  RecourseClaims: abiFile('RecourseClaims'),
  DepositVault: abiFile('DepositVault'),
  RecourseCase: abiFile('RecourseCase'),
  EvidenceModule: viem.parseAbi(['function submitEvidence(uint256 _externalDisputeID, string _evidence)']),
  VaultToken: viem.erc20Abi,
};
export const ACTION_CALLS = {
  fileClaim: ['VaultToken.approve', 'RecourseClaims.fileClaim'],
  contest: ['RecourseClaims.contest'],
  submitEvidence: ['EvidenceModule.submitEvidence'],
  withdrawCredit: ['DepositVault.withdrawCredit'],
  closeUncontested: ['RecourseClaims.closeUncontested'],
  sendToCourt: ['RecourseClaims.sendToCourt'],
  resend: ['RecourseClaims.resend'],
  expireClaim: ['RecourseClaims.expireClaim'],
  settle: ['RecourseClaims.settle'],
  openCase: ['RecourseCase.openCase'],
  refile: ['RecourseCase.refile'],
  relayRuling: ['RecourseCase.relayRuling'],
};

function norm(v) {
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
  return v;
}

/** Null when `data` decodes to exactly the call the API shows; otherwise why not. */
export function callMismatch(tx) {
  const abi = CALL_ABIS[tx.call?.contract];
  if (!abi) return `unknown contract ${tx.call?.contract}`;
  let d;
  try {
    d = viem.decodeFunctionData({ abi, data: tx.data });
  } catch {
    return `data does not decode as a ${tx.call.contract} call`;
  }
  if (d.functionName !== tx.call.function) return `data calls ${d.functionName}, the answer says ${tx.call.function}`;
  const fn = abi.find((f) => f.type === 'function' && f.name === d.functionName && (f.inputs?.length ?? 0) === (d.args?.length ?? 0));
  const named = Object.fromEntries((fn?.inputs ?? []).map((input, i) => [input.name || String(i), d.args?.[i]]));
  if (JSON.stringify(norm(named)) !== JSON.stringify(norm(tx.call.args))) return 'decoded args differ from call.args';
  return null;
}

// ---- send mode: the role's signer, loaded in this process with the repo's loader ----

export const ROLE_KEY_ENV = Object.freeze({
  shop: 'SHOP_KEY_FILE',
  platform: 'PLATFORM_KEY_FILE',
  agent: 'AGENT_KEY_FILE',
  buyer: 'BUYER_KEY_FILE',
  scheme: 'SCHEME_KEY_FILE',
  'ops-arb': 'OPS_ARB_KEY_FILE',
  'ops-hedera': 'OPS_HEDERA_KEY_FILE',
});

/**
 * The read shows the change, as the web app's readBackShows decides it: an event or evidence from one of
 * the sent transactions, the credit gone down, or the status the preview promised.
 */
export function readBackShows(a, body, hashes) {
  const hs = new Set(hashes.map((h) => h.toLowerCase()));
  if (body.party) return body.party.credit !== null && BigInt(body.party.credit) < BigInt(String(a.input?.credit ?? '0'));
  const c = body.claim;
  if (c.events?.some((e) => hs.has(e.tx.toLowerCase()))) return true;
  if (c.court?.evidence?.some((e) => hs.has(e.tx.toLowerCase()))) return true;
  return a.preview.statusAfter !== null && c.statusKey === a.preview.statusAfter;
}

let parties = null;
/**
 * Reads the party map once with packages/shared's readParties (PARTIES_FILE, else the checkout's
 * deployments/parties.json). Public addresses only; the keys stay where they are. Each role maps to
 * one party through partyByRole, the services' own pick: once the demo cast adds more shops,
 * platforms and agents, RECOURSE_SHOP_ADDRESS, RECOURSE_PLATFORM_ADDRESS and RECOURSE_AGENT_ADDRESS
 * name the ones under test.
 */
export async function loadParties() {
  const { readParties } = await repoModule('packages/shared/src/node/index.ts');
  const { partyByRole } = await repoModule('packages/shared/src/parties.ts');
  const list = readParties({ PARTIES_FILE: process.env.PARTIES_FILE || join(DEPLOYMENTS_DIR, 'parties.json') });
  const roles = [...new Set(list.map((p) => p.role))];
  parties = Object.fromEntries(roles.map((role) => [role, viem.getAddress(partyByRole(list, role, process.env).evmAddress)]));
  return parties;
}

/** Role to address, from the party map loadParties read. */
export function partyAddresses() {
  if (!parties) throw new Error('loadParties() has not run');
  return parties;
}

/**
 * What this checkout's deployments say, read with the status API's own loader and the records
 * package's topic loader: the contract addresses, chain ids, vault token and records topic.
 */
export async function checkoutDeployments() {
  const { loadDeployments } = await repoModule('services/status-api/src/deployments.ts');
  const { recordsTopicId } = await repoModule('packages/records/src/open.ts');
  const d = loadDeployments(DEPLOYMENTS_DIR);
  let topic = null;
  try {
    topic = recordsTopicId(process.env);
  } catch {
    topic = null;
  }
  return {
    files: d.files,
    local: d.local,
    claims: d.claims ?? null,
    vault: d.vault ?? null,
    recourseCase: d.caseAddress ?? null,
    usdc: d.token.address,
    vaultToken: d.token,
    evidenceModule: d.outside.evidenceModule,
    klerosCore: d.outside.klerosCore,
    chains: { hedera: d.hederaChainId, arbitrum: d.arbitrumChainId },
    recordsTopic: topic,
    topicFrom: process.env.HCS_RECORDS_TOPIC_ID?.trim() ? 'HCS_RECORDS_TOPIC_ID' : 'packages/records/h0-ids.json',
  };
}

/** One variable from the environment, else from the shared env file; the value is never printed. */
function envValue(name) {
  if (process.env[name]) return process.env[name];
  const file = process.env.RECOURSE_ENV_FILE ?? join(homedir(), '.config/recourse/recourse.env');
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_0-9]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

/** viem account for the role, decrypted by packages/shared's loadSigner (needs tsx for the .ts file). */
export async function loadRoleSigner(role) {
  const envName = ROLE_KEY_ENV[role];
  if (!envName) throw new Error(`--as: one of ${Object.keys(ROLE_KEY_ENV).join(', ')}`);
  const { loadSigner } = await repoModule('packages/shared/src/node/keystore.ts');
  const value = envValue(envName);
  // loadSigner's errors name the variable and the problem, never the path or the password.
  return loadSigner(envName, { [envName]: value });
}

/**
 * Signs and sends one built transaction from `account` on its test chain: legacy pricing at the
 * higher of the built and the current gas price, the gas limit as built. Waits for the receipt.
 */
export async function sendBuilt(account, rpc, tx, { receiptTimeoutMs = 180_000, wait = true } = {}) {
  await rpc.guard();
  if (Number(tx.chainId) !== rpc.chainId) throw new Error(`transaction is for chain ${tx.chainId}, the RPC is ${rpc.chainId}`);
  const chain = viem.defineChain({ id: rpc.chainId, name: TEST_CHAINS[rpc.chainId], nativeCurrency: { name: 'native', symbol: rpc.chainId === 296 ? 'HBAR' : 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc.url] } } });
  const transport = viem.http(rpc.url, { timeout: 30_000, retryCount: 1 });
  const wallet = viem.createWalletClient({ account, chain, transport });
  const pub = viem.createPublicClient({ chain, transport, pollingInterval: rpc.chainId === 296 ? 2000 : 500 });
  const now = await pub.getGasPrice();
  const gasPrice = now > BigInt(tx.gasPrice) ? now : BigInt(tx.gasPrice);
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value), gas: BigInt(tx.gas), gasPrice, type: 'legacy' });
  if (!wait) return { hash };
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs });
  return { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), block: receipt.blockNumber.toString() };
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
}
