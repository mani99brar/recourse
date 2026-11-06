// The status API's /v1 routes as the agent's and the shop's commands call them: the same reads and
// POST /v1/actions/{name} the web app uses (services/status-api/API.md). The API builds unsigned
// transactions and a preview; it never signs, holds a key or broadcasts. A command checks every
// built transaction against the call it means to make (the contract's address from this checkout's
// deployment file, the function and arguments decoded from the data, the chain, the signer), prints
// the preview, signs each transaction with the role's own key in this process, sends them in order
// through its own RPC, each after the one before it has mined, and reads the result back through
// the API. The key never leaves the process and is never printed.

import { decodeFunctionData, getAddress, isAddress, isHex, keccak256, type Abi, type Address, type Hex, type LocalAccount, type PublicClient } from 'viem';
import { ARBITRUM_SEPOLIA_CHAIN_ID, HEDERA_TESTNET_CHAIN_ID } from '@recourse/shared';

type Env = Record<string, string | undefined>;

export const DEFAULT_STATUS_API_URL = 'http://127.0.0.1:8787';

/** STATUS_API_URL without a trailing slash; the status API on this host when it is not set. */
export function statusApiUrl(env: Env = process.env): string {
  return (env.STATUS_API_URL || DEFAULT_STATUS_API_URL).replace(/\/+$/, '');
}

export const ACTION_NAMES = [
  'fileClaim', 'contest', 'submitEvidence', 'withdrawCredit', 'closeUncontested', 'sendToCourt',
  'resend', 'expireClaim', 'settle', 'openCase', 'refile', 'relayRuling',
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export type Movement = 'escrow' | 'reserve' | 'credit' | 'receive' | 'send' | 'contract_pays' | 'info';

/** One unsigned transaction as the API answers it: integers as decimal strings. */
export interface BuiltTx {
  chainId: number;
  to: Address;
  data: Hex;
  value: string;
  gas: string;
  gasPrice: string;
  description: string;
  call: { contract: string; function: string; args: Record<string, unknown> };
  simulated: boolean;
}

export interface PreviewAmount {
  name: string;
  amount: string;
  decimals: number;
  symbol: string;
  display: string;
  movement: Movement;
  account: string | null;
}

export interface BuiltAction {
  action: ActionName;
  chain: 'hedera' | 'arbitrum';
  chainId: number;
  from: Address;
  claimId: Hex | null;
  transactions: BuiltTx[];
  preview: {
    summary: string;
    amounts: PreviewAmount[];
    fee: { amount: string; decimals: number; symbol: string; display: string; gas: string; gasPrice: string; basis: 'estimate' | 'budget' };
    changes: string[];
    statusAfter: string | null;
    notes: string[];
  };
  simulated: boolean;
  builtAt: string;
  notAfter: string | null;
  readBack: string;
  input: Record<string, unknown>;
}

/** A /v1 error answer, `{ error: { code, message, details } }`, or the client's own `unreachable` and `bad_answer`. */
export class V1Failure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly said: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${said}`);
    this.name = 'V1Failure';
  }

  /** 4xx: the API refused the request (the chain does not allow it, or the input is wrong). */
  get refused(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

function failureFrom(status: number, body: unknown): V1Failure {
  const e = (body as { error?: unknown } | null | undefined)?.error;
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') {
    const { code, message, details } = e as { code: string; message?: unknown; details?: unknown };
    return new V1Failure(status, code, typeof message === 'string' ? message : `HTTP ${status}`, details && typeof details === 'object' ? (details as Record<string, unknown>) : {});
  }
  if (typeof e === 'string') return new V1Failure(status, e, `HTTP ${status}`);
  return new V1Failure(status, 'bad_answer', `the status API answered HTTP ${status} without a v1 error`);
}

export interface V1Client {
  base: string;
  get<T>(path: string): Promise<T>;
  post(name: ActionName, body: Record<string, unknown>): Promise<BuiltAction>;
}

/** /v1/params reads the chain for its facts, and a slow Hedera relay can hold it for tens of seconds. */
export const V1_TIMEOUT_MS = 60_000;

export function v1Client(base: string, fetcher: typeof fetch = fetch, timeoutMs = V1_TIMEOUT_MS): V1Client {
  const call = async (path: string, init: RequestInit): Promise<{ status: number; body: unknown }> => {
    let r: Response;
    try {
      r = await fetcher(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const late = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new V1Failure(0, 'unreachable', late ? `the status API at ${base} did not answer ${path} within ${timeoutMs / 1000} s` : `the status API at ${base} cannot be reached`);
    }
    const body = (await r.json().catch(() => null)) as unknown;
    if (!r.ok) throw failureFrom(r.status, body);
    return { status: r.status, body };
  };
  return {
    base,
    async get<T>(path: string): Promise<T> {
      return (await call(path, { headers: { accept: 'application/json' } })).body as T;
    },
    async post(name, body) {
      const r = await call(`/v1/actions/${name}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!looksBuilt(r.body)) throw new V1Failure(r.status, 'bad_answer', 'the status API answered in a form this command does not know, so nothing will be signed');
      return r.body;
    },
  };
}

const UINT = /^(0|[1-9][0-9]*)$/;
const uint = (v: unknown): boolean => typeof v === 'string' && UINT.test(v);

/** The answer has the contract's shape, down to every number this command turns into a BigInt. */
export function looksBuilt(v: unknown): v is BuiltAction {
  const o = v as Partial<BuiltAction> | null;
  if (!o || typeof o !== 'object' || typeof o.action !== 'string' || typeof o.from !== 'string' || typeof o.chainId !== 'number') return false;
  if (!Array.isArray(o.transactions) || o.transactions.length < 1 || o.transactions.length > 2 || typeof o.readBack !== 'string' || !uint(o.builtAt)) return false;
  if (o.notAfter !== null && !uint(o.notAfter)) return false;
  const txOk = o.transactions.every(
    (t) => !!t && typeof t.chainId === 'number' && typeof t.to === 'string' && typeof t.data === 'string' && uint(t.value) && uint(t.gas) && uint(t.gasPrice) && typeof t.description === 'string' && !!t.call && typeof t.call.contract === 'string' && typeof t.call.function === 'string' && !!t.call.args && typeof t.call.args === 'object',
  );
  const p = o.preview;
  const previewOk =
    !!p && typeof p.summary === 'string' && Array.isArray(p.amounts) && Array.isArray(p.changes) && Array.isArray(p.notes) &&
    p.amounts.every((a) => !!a && typeof a.name === 'string' && uint(a.amount) && Number.isInteger(a.decimals) && typeof a.symbol === 'string') &&
    !!p.fee && uint(p.fee.amount) && uint(p.fee.gas) && Number.isInteger(p.fee.decimals) && typeof p.fee.symbol === 'string';
  return txOk && previewOk;
}

// ------------------------------------------------------------------ checking what was built

/** A call a command means to make: `functionName` with exactly `args` on the contract at `to`, decoded with `abi`. */
export interface IntendedCall {
  /** The API's label for the contract: RecourseClaims, DepositVault, VaultToken, RecourseCase, EvidenceModule. */
  contract: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Native value sent with it; none when absent. */
  value?: bigint;
}

export interface Asked {
  action: ActionName;
  from: Address;
  chainId: number;
  /** The claim the action is for; null for an action on no claim (withdrawCredit). */
  claimId: Hex | null;
  /** The calls, in signing order. */
  calls: readonly IntendedCall[];
}

/** Integers as decimal text, hex in lower case and object keys sorted, so a decoded value and an intended one compare equal. */
function norm(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
  }
  return v;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Why `tx` is not `want`, from its data and the call it shows; null when it is exactly that call. */
function txProblem(tx: BuiltTx, want: IntendedCall): string | null {
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: want.abi, data: tx.data }) as { functionName: string; args?: readonly unknown[] };
  } catch {
    return `its data is not a ${want.contract} call`;
  }
  if (decoded.functionName !== want.functionName) return `its data calls ${decoded.functionName}`;
  const args = decoded.args ?? [];
  if (args.length !== want.args.length || !want.args.every((a, i) => same(args[i], a))) {
    const fn = want.abi.find((f) => f.type === 'function' && f.name === want.functionName);
    const inputs = fn && fn.type === 'function' ? fn.inputs : [];
    const differ = want.args.map((a, i) => (same(args[i], a) ? null : (inputs[i]?.name || String(i)))).filter((n): n is string => n !== null);
    return `its data carries other arguments (${differ.join(', ') || 'count'}) than this command means`;
  }
  // What the API shows beside the data must be the same call, so the preview describes what is signed.
  if (tx.call.contract !== want.contract || tx.call.function !== want.functionName) return `it is shown as ${tx.call.contract}.${tx.call.function}`;
  const fn = want.abi.find((f) => f.type === 'function' && f.name === want.functionName);
  const inputs = fn && fn.type === 'function' ? fn.inputs : [];
  const named = Object.fromEntries(inputs.map((input, i) => [input.name || String(i), args[i]]));
  if (!same(named, tx.call.args)) return 'the arguments it shows differ from its data';
  return null;
}

/**
 * Every reason not to sign this answer; empty when it may be signed. It must be the action asked
 * for, built for the signer and the claim asked for, on the expected chain, every transaction going
 * to the intended contract with data that decodes to exactly the intended call, no value the preview
 * does not show as sent, no fee above the preview's, and a deadline still ahead. The gas price is
 * checked against the chain's own just before signing (signAndSend).
 */
export function signingProblems(resp: BuiltAction, asked: Asked, nowS: number = Date.now() / 1000): string[] {
  const out: string[] = [];
  if (resp.action !== asked.action) out.push(`the API built ${resp.action}, not ${asked.action}`);
  if (!sameAddress(resp.from, asked.from)) out.push(`it was built for ${resp.from}, not the signer ${asked.from}`);
  if ((resp.claimId ?? '').toLowerCase() !== (asked.claimId ?? '').toLowerCase()) out.push(`it was built for claim ${resp.claimId ?? 'none'}, not ${asked.claimId ?? 'none'}`);
  if (resp.chainId !== asked.chainId) out.push(`it is for chain ${resp.chainId}, not ${asked.chainId}`);
  const want = asked.calls.map((c) => `${c.contract}.${c.functionName}`).join(' then ');
  if (resp.transactions.length !== asked.calls.length) {
    out.push(`it holds ${resp.transactions.length} transaction(s), not ${asked.calls.length} (${want})`);
  } else {
    resp.transactions.forEach((tx, i) => {
      const c = asked.calls[i]!;
      const n = `step ${i + 1} (${c.contract}.${c.functionName})`;
      if (tx.chainId !== asked.chainId) out.push(`${n} is on chain ${tx.chainId}`);
      if (!isAddress(tx.to, { strict: false }) || !isHex(tx.data)) out.push(`${n} has no valid target or data`);
      else {
        if (getAddress(tx.to) !== getAddress(c.to)) out.push(`${n} goes to ${getAddress(tx.to)}, not ${c.contract} at ${getAddress(c.to)}`);
        const why = txProblem(tx, c);
        if (why) out.push(`${n}: ${why}`);
      }
      if (BigInt(tx.value) !== (c.value ?? 0n)) out.push(`${n} sends a value of ${tx.value}, not ${c.value ?? 0n}`);
      if (BigInt(tx.gas) === 0n) out.push(`${n} has no gas limit`);
    });
  }
  const value = resp.transactions.reduce((s, t) => s + BigInt(t.value), 0n);
  const shown = resp.preview.amounts.filter((a) => a.movement === 'send').reduce((s, a) => s + BigInt(a.amount), 0n);
  if (value !== shown) out.push('the transactions send a value the preview does not show');
  const fee = resp.transactions.reduce((s, t) => s + BigInt(t.gas) * BigInt(t.gasPrice), 0n);
  if (fee > BigInt(resp.preview.fee.amount)) out.push(`their gas limits at their gas prices allow a fee of ${fee}, above the ${resp.preview.fee.amount} the preview shows`);
  if (resp.notAfter !== null && nowS > Number(resp.notAfter)) out.push(`the deadline for this call passed at ${isoOf(resp.notAfter)}`);
  return out;
}

/**
 * Where /v1/params says the contracts are, against this checkout's deployment file: they must be
 * the same contracts, or every transaction would be refused anyway. Empty when they agree.
 */
export function deploymentProblems(params: V1Params, expected: { chainId: number; claims?: Address; vault?: Address; recourseCase?: Address; evidenceModule?: Address; chain: 'hedera' | 'arbitrum' }): string[] {
  const out: string[] = [];
  const served = params.chains?.[expected.chain];
  if (served !== expected.chainId) out.push(`the status API serves ${expected.chain} chain ${served ?? 'none'}, the deployment file is for chain ${expected.chainId}`);
  for (const k of ['claims', 'vault', 'recourseCase', 'evidenceModule'] as const) {
    const want = expected[k];
    if (want === undefined) continue;
    const got = params.addresses?.[k];
    if (!sameAddress(got, want)) out.push(`the status API serves ${k} ${got ?? 'none'}, the deployment file names ${want}`);
  }
  return out;
}

export interface V1Params {
  addresses?: Partial<Record<'claims' | 'vault' | 'recourseCase' | 'usdc' | 'evidenceModule', string | null>>;
  chains?: Partial<Record<'hedera' | 'arbitrum', number>>;
  params?: { claims?: { courtFeeUsdc?: string; contestWindow?: string; claimTimeout?: string } };
}

// ------------------------------------------------------------------ the preview in words

export function chainLabel(chainId: number): string {
  if (chainId === HEDERA_TESTNET_CHAIN_ID) return 'Hedera testnet (296)';
  if (chainId === ARBITRUM_SEPOLIA_CHAIN_ID) return 'Arbitrum Sepolia (421614)';
  return `local chain ${chainId}`;
}

export function isoOf(seconds: bigint | string | number): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

const MOVEMENT_WORDS: Record<Movement, string> = {
  escrow: 'leaves the account into the claim escrow',
  reserve: 'held from the deposit in the vault',
  credit: 'added to vault credit',
  receive: 'arrives in the account',
  send: 'paid from the signer with the transaction',
  contract_pays: 'paid by the contract from its own balance',
  info: 'shown for information; nothing moves',
};

/** The preview as lines: what happens, the amounts, the network and fee, each transaction, the notes. */
export function previewLines(resp: BuiltAction): string[] {
  const p = resp.preview;
  const lines = [`${resp.action} on ${chainLabel(resp.chainId)}, signed by ${resp.from}`, `  ${p.summary}`];
  for (const a of p.amounts) lines.push(`  ${a.name}: ${a.display} (${a.amount} base units), ${MOVEMENT_WORDS[a.movement] ?? a.movement}${a.account ? ` [${a.account}]` : ''}`);
  if (p.amounts.length === 0) lines.push('  no money moves');
  const basis = p.fee.basis === 'budget' ? 'part of it a fixed gas budget for a step that cannot be simulated until the step before it has mined' : 'estimated by simulating against the latest block';
  lines.push(`  network fee: at most ${p.fee.display} for ${p.fee.gas} gas at ${p.fee.gasPrice} a gas (${basis}); the chain charges for the gas used`);
  resp.transactions.forEach((tx, i) => {
    lines.push(`  step ${i + 1} of ${resp.transactions.length}: ${tx.call.contract}.${tx.call.function} at ${tx.to}, gas limit ${tx.gas}${tx.value !== '0' ? `, value ${tx.value}` : ''}${tx.simulated ? '' : ' (not simulated yet)'}`);
    lines.push(`    ${tx.description}`);
  });
  for (const c of p.changes) lines.push(`  then: ${c}`);
  if (p.statusAfter) lines.push(`  claim status after: ${p.statusAfter}`);
  if (resp.notAfter !== null) lines.push(`  must mine by ${isoOf(resp.notAfter)}`);
  for (const n of p.notes) lines.push(`  note: ${n}`);
  return lines;
}

/** A typed API error as the commands print it: code and message, then the facts that help. */
export function failureLines(e: V1Failure): string[] {
  const lines = [`${e.code}: ${e.said}`];
  const facts = Object.entries(e.details)
    .filter(([k]) => k !== 'revert')
    .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  const revert = e.details.revert as { contract?: string; name?: string } | undefined;
  if (revert?.name) facts.push(`revert ${revert.contract ?? ''} ${revert.name}`.replace(/\s+/g, ' '));
  if (facts.length > 0) lines.push(`  (${facts.join('; ')})`);
  return lines;
}

// ------------------------------------------------------------------ signing and sending

/** The few RPC calls signing and sending need; `viemRpc` adapts a viem client. */
export interface ChainRpc {
  chainId(): Promise<number>;
  /** The gas price the node asks now (eth_gasPrice). */
  gasPrice(): Promise<bigint>;
  /** The next nonce, counting pending transactions. */
  nonce(address: Address): Promise<number>;
  sendRaw(raw: Hex): Promise<void>;
  receipt(hash: Hex, timeoutMs: number): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }>;
}

export function viemRpc(client: PublicClient): ChainRpc {
  return {
    chainId: () => client.getChainId(),
    gasPrice: () => client.getGasPrice(),
    nonce: (address) => client.getTransactionCount({ address, blockTag: 'pending' }),
    sendRaw: async (raw) => {
      await client.sendRawTransaction({ serializedTransaction: raw });
    },
    receipt: async (hash, timeoutMs) => {
      const r = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
      return { status: r.status, blockNumber: r.blockNumber };
    },
  };
}

/** A send that stopped: the steps before it stay sent, and `hashes` holds every hash signed so far. */
export class SendStopped extends Error {
  constructor(
    readonly reason: 'wrong_chain' | 'wrong_signer' | 'too_late' | 'stale' | 'gas_price' | 'fee_changed' | 'reverted' | 'send_failed',
    message: string,
    readonly hashes: Hex[] = [],
  ) {
    super(message);
    this.name = 'SendStopped';
  }
}

/** A preview older than this is built again before signing, as the web app does: fees, allowances and quotes move. */
export const STALE_AFTER_S = 300;

/**
 * The most a built gas price may be over the price the sending RPC asks, as a multiple. No wallet
 * stands between the preview and the signature here, so this is the check a wallet's own fee would
 * be: an API answering a price in the wrong unit, or a stale spike, is not paid from the role's account.
 */
export const GAS_PRICE_SLACK = 2n;

export interface SendOptions {
  account: LocalAccount;
  rpc: ChainRpc;
  /**
   * For a step the API could not simulate (fileClaim before its approve has mined): the gas the API
   * estimates for the same call once the steps before it have mined, or null.
   */
  regas?: (tx: BuiltTx) => Promise<string | null>;
  receiptTimeoutMs?: number;
  nowS?: () => number;
  /** Each signed transaction, before it is broadcast (a journal writes it here), and each mined one. */
  onSigned?: (i: number, s: { hash: Hex; nonce: number; raw: Hex }) => void;
  onMined?: (i: number, m: { hash: Hex; status: 'success' | 'reverted'; blockNumber: bigint }) => void;
}

/**
 * Signs and sends every transaction exactly as built (target, data, value, gas limit, gas price,
 * chain), in order, waiting for each receipt before the next, once the RPC is on the right chain
 * and asks a gas price the built one is not far above (GAS_PRICE_SLACK). A step built with a fixed
 * gas budget takes the API's estimate once the steps before it have mined, when that is at most the
 * budget; above it the preview's fee no longer holds and it stops (`fee_changed`).
 */
export async function signAndSend(resp: BuiltAction, o: SendOptions): Promise<Hex[]> {
  const nowS = o.nowS ?? (() => Date.now() / 1000);
  const hashes: Hex[] = [];
  if (getAddress(o.account.address) !== getAddress(resp.from)) throw new SendStopped('wrong_signer', `the key is ${o.account.address}, the API built for ${resp.from}`);
  const served = await o.rpc.chainId();
  if (served !== resp.chainId) throw new SendStopped('wrong_chain', `the RPC serves chain ${served}, the transactions are for chain ${resp.chainId}`);
  if (resp.notAfter !== null && nowS() > Number(resp.notAfter)) throw new SendStopped('too_late', `the deadline passed at ${isoOf(resp.notAfter)}`);
  if (nowS() - Number(resp.builtAt) > STALE_AFTER_S) throw new SendStopped('stale', 'the preview is more than five minutes old; build it again');
  let asked: bigint;
  try {
    asked = await o.rpc.gasPrice();
  } catch {
    throw new SendStopped('gas_price', "the RPC's gas price cannot be read, so the API's cannot be checked; nothing signed");
  }
  resp.transactions.forEach((tx, i) => {
    if (BigInt(tx.gasPrice) > asked * GAS_PRICE_SLACK) throw new SendStopped('gas_price', `step ${i + 1} is priced at ${tx.gasPrice} a gas, over ${GAS_PRICE_SLACK} times the ${asked} the RPC asks now; build it again`);
  });
  for (let i = 0; i < resp.transactions.length; i++) {
    let tx = resp.transactions[i]!;
    if (resp.notAfter !== null && nowS() > Number(resp.notAfter)) throw new SendStopped('too_late', `the deadline passed at ${isoOf(resp.notAfter)}`, hashes);
    if (!tx.simulated && i > 0 && o.regas) {
      const gas = await o.regas(tx).catch(() => null);
      if (gas !== null && UINT.test(gas) && BigInt(gas) > 0n) {
        if (BigInt(gas) > BigInt(tx.gas)) throw new SendStopped('fee_changed', `step ${i + 1} now needs ${gas} gas, above its ${tx.gas} budget; build it again`, hashes);
        tx = { ...tx, gas };
      }
    }
    const nonce = await o.rpc.nonce(o.account.address);
    const raw = await o.account.signTransaction({
      chainId: tx.chainId,
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value),
      gas: BigInt(tx.gas),
      gasPrice: BigInt(tx.gasPrice),
      nonce,
      type: 'legacy',
    });
    const hash = keccak256(raw);
    o.onSigned?.(i, { hash, nonce, raw });
    hashes.push(hash);
    try {
      await o.rpc.sendRaw(raw);
    } catch (error) {
      throw new SendStopped('send_failed', `step ${i + 1} ${hash} was refused: ${error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : String(error)}`, hashes);
    }
    const r = await o.rpc.receipt(hash, o.receiptTimeoutMs ?? 120_000);
    o.onMined?.(i, { hash, ...r });
    if (r.status !== 'success') throw new SendStopped('reverted', `step ${i + 1} reverted in ${hash}`, hashes);
  }
  return hashes;
}

/** The gas the API now estimates for `tx` in a fresh answer for the same action and signer: only for the same simulated call. */
export function sameCallGas(resp: BuiltAction, again: BuiltAction, tx: BuiltTx): string | null {
  if (again.action !== resp.action || !sameAddress(again.from, resp.from)) return null;
  const t = again.transactions.find((x) => x.simulated && x.chainId === tx.chainId && sameAddress(x.to, tx.to) && x.data.toLowerCase() === tx.data.toLowerCase() && x.value === tx.value);
  return t ? t.gas : null;
}

// ------------------------------------------------------------------ reading the result back

/** A read-back path is one of the API's own /v1 reads, never a URL somewhere else. */
export function readBackPath(path: string): string | null {
  return /^\/v1\/(claims|parties)\/0x[0-9a-fA-F]+$/.test(path) ? path : null;
}

export interface ClaimRead {
  claim: {
    claimId: string;
    statusKey: string;
    findingSide?: string | null;
    nextActor?: string;
    nextAction?: { action: string; actor: string; deadline: string | null } | null;
    contest?: { by: string | null; windowEndsAt?: string | null };
    court?: { evidence?: { tx: string; attempt: number }[] };
    events?: { name: string; tx: string; chain: string }[];
    escrow?: { amount: string; fate: string };
    credited?: string | null;
    basketUsdc?: string;
    netLossUsdc?: string;
  };
}
export interface PartyRead {
  party: { address: string; credit: string | null; balance?: string | null };
}
export type ReadBody = ClaimRead | PartyRead;

/** The read shows the change: an event or evidence from a sent transaction, the credit gone down, or the expected status. */
export function readBackShows(resp: BuiltAction, body: ReadBody, hashes: readonly string[]): boolean {
  const hs = new Set(hashes.map((h) => h.toLowerCase()));
  if ('party' in body) {
    const before = BigInt(String(resp.input.credit ?? '0'));
    return body.party.credit !== null && BigInt(body.party.credit) < before;
  }
  const c = body.claim;
  if (c.events?.some((e) => hs.has(e.tx.toLowerCase()))) return true;
  if (c.court?.evidence?.some((e) => hs.has(e.tx.toLowerCase()))) return true;
  return resp.preview.statusAfter !== null && c.statusKey === resp.preview.statusAfter;
}

/**
 * Polls the answer's readBack path until it shows the sent transactions. A claim filed moments ago
 * answers 404 until the index reaches it, so a 404 is waited through like any other miss.
 */
export async function readBack(
  client: V1Client,
  resp: BuiltAction,
  hashes: readonly string[],
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ body: ReadBody | null; shows: boolean }> {
  const path = readBackPath(resp.readBack);
  if (!path) return { body: null, shows: false };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? 3000;
  const tries = Math.max(1, Math.ceil((opts.timeoutMs ?? 180_000) / interval));
  let last: ReadBody | null = null;
  for (let i = 0; i < tries; i++) {
    try {
      const body = await client.get<ReadBody>(path);
      last = body;
      if (readBackShows(resp, body, hashes)) return { body, shows: true };
    } catch {
      // A 404 before the index reaches a new claim, a 503 or a dropped connection: try again.
    }
    if (i < tries - 1) await sleep(interval);
  }
  return { body: last, shows: false };
}

/** A claim or party read as lines. */
export function stateLines(body: ReadBody, hashes: readonly string[] = []): string[] {
  if ('party' in body) {
    const p = body.party;
    return [`party ${p.address}: credit ${p.credit ?? 'not read'}${p.balance !== undefined ? `, deposit ${p.balance ?? 'not read'}` : ''}`];
  }
  const c = body.claim;
  const lines = [`claim ${c.claimId}: status ${c.statusKey}${c.findingSide ? `, pre-check finding: ${c.findingSide}` : ''}`];
  const next = c.nextAction ? `${c.nextAction.action} by ${c.nextAction.actor}${c.nextAction.deadline ? `, by ${isoOf(c.nextAction.deadline)}` : ''}` : `nothing this API builds${c.nextActor && c.nextActor !== 'none' ? ` (waiting on ${c.nextActor})` : ''}`;
  lines.push(`  next: ${next}`);
  if (c.basketUsdc !== undefined) lines.push(`  basket ${c.basketUsdc}, net loss ${c.netLossUsdc ?? '?'}${c.credited ? `, credited ${c.credited}` : ''}${c.escrow ? `; court fee escrow ${c.escrow.amount}, ${c.escrow.fate}` : ''}`);
  if (c.contest?.windowEndsAt) lines.push(`  contest window ends ${isoOf(c.contest.windowEndsAt)}${c.contest.by ? `; contested by ${c.contest.by}` : ''}`);
  const hs = new Set(hashes.map((h) => h.toLowerCase()));
  for (const e of c.events ?? []) if (hs.has(e.tx.toLowerCase())) lines.push(`  event ${e.name} in ${e.tx}`);
  return lines;
}

export function explorerLink(chainId: number, hash: Hex): string | null {
  if (chainId === HEDERA_TESTNET_CHAIN_ID) return `https://hashscan.io/testnet/transaction/${hash}`;
  if (chainId === ARBITRUM_SEPOLIA_CHAIN_ID) return `https://sepolia.arbiscan.io/tx/${hash}`;
  return null;
}
