// Shared assembly for the actions: encode a call from the deployed ABI, simulate it as the signer
// against the latest block, add the gas margin, and put the answer together. Nothing here signs,
// holds a key or broadcasts.

import { encodeFunctionData, getAddress, type AbiFunction, type AbiParameter, type Address, type Hex } from 'viem';
import { ABI_OF, type ContractLabel } from '../abi/deployed.js';
import type { ActionReads, ChainName } from '../chain.js';
import type { Deployments } from '../deployments.js';
import type { ErrorDetails } from './errors.js';
import { ETH, feeText, type Amount, type Unit } from './format.js';
import { decodeRevert, revertError } from './reverts.js';

export const ACTION_NAMES = [
  'fileClaim',
  'contest',
  'submitEvidence',
  'withdrawCredit',
  'closeUncontested',
  'sendToCourt',
  'resend',
  'expireClaim',
  'settle',
  'openCase',
  'refile',
  'relayRuling',
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export function isActionName(v: unknown): v is ActionName {
  return typeof v === 'string' && (ACTION_NAMES as readonly string[]).includes(v);
}

/** Native HBAR as the JSON-RPC relay counts gas prices and fees (weibar, 18 decimals). */
const WEIBAR: Unit = { decimals: 18, symbol: 'HBAR' };

/** Gas margins on the node's estimate, as the shop and the keeper sign with them. */
const MARGIN: Record<ChainName, [bigint, bigint]> = { hedera: [13n, 10n], arbitrum: [12n, 10n] };

/** Measured execution gas with headroom (the keeper's floors), for calls whose estimate may miss a branch. */
export const GAS_FLOORS: Partial<Record<string, bigint>> = {
  openCase: 1_300_000n,
  refile: 1_300_000n,
  relayRuling: 450_000n,
};

/**
 * fileClaim's gas limit when it cannot be simulated before its approve mines. On Hedera testnet the
 * deployed pair's fileClaim used 559,974 and 559,986 gas (the shop's last two, signed at its x1.3
 * margin as 764,630 and 764,645). The current contracts also freeze the claim's terms and reserve
 * the deposit at filing, four more new storage slots (about 90k), so about 650k. 800k covers both.
 * Hedera bills at least 80% of the limit (640k gas); a fileClaim that runs out of gas is billed too,
 * and has to be sent again.
 */
export const FILE_CLAIM_BUDGET = 800_000n;

export interface UnsignedTx {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  gasPrice: bigint;
  description: string;
  call: { contract: ContractLabel; function: string; args: Record<string, unknown> };
  simulated: boolean;
}

export interface Preview {
  summary: string;
  amounts: Amount[];
  fee: { amount: bigint; decimals: number; symbol: string; display: string; gas: bigint; gasPrice: bigint; basis: 'estimate' | 'budget' };
  changes: string[];
  statusAfter: string | null;
  notes: string[];
}

export interface ActionAnswer {
  action: ActionName;
  chain: ChainName;
  chainId: number;
  from: Address;
  claimId: Hex | null;
  transactions: UnsignedTx[];
  preview: Preview;
  simulated: boolean;
  builtAt: bigint;
  notAfter: bigint | null;
  readBack: string;
  input: Record<string, unknown>;
}

export interface Ctx {
  chain: ActionReads;
  dep: Deployments;
}

export function chainIdOf(dep: Deployments, chain: ChainName): number {
  return chain === 'hedera' ? dep.hederaChainId : dep.arbitrumChainId;
}

/** A value as the API writes it: integers as decimal strings, addresses checksummed, bytes lower case. */
function argOut(p: AbiParameter, v: unknown): unknown {
  if (p.type.endsWith(']')) {
    const inner = { ...p, type: p.type.slice(0, p.type.lastIndexOf('[')) } as AbiParameter;
    return (v as readonly unknown[]).map((x) => argOut(inner, x));
  }
  if (p.type === 'tuple') {
    const comps = (p as { components?: readonly AbiParameter[] }).components ?? [];
    const src = v as Record<string, unknown> & readonly unknown[];
    return Object.fromEntries(comps.map((c, i) => [c.name ?? String(i), argOut(c, src[c.name ?? ''] ?? src[i])]));
  }
  if (typeof v === 'bigint' || typeof v === 'number') return v.toString();
  if (p.type === 'address' && typeof v === 'string') return getAddress(v);
  if (typeof v === 'string' && p.type.startsWith('bytes')) return v.toLowerCase();
  return v;
}

function fnOf(contract: ContractLabel, name: string): AbiFunction {
  const f = ABI_OF[contract].find((x) => x.type === 'function' && x.name === name) as AbiFunction | undefined;
  if (!f) throw new Error(`no ${contract}.${name} in the ABI`);
  return f;
}

export interface TxSpec {
  chain: ChainName;
  contract: ContractLabel;
  to: Address;
  fn: string;
  args: readonly unknown[];
  from: Address;
  value?: bigint;
  gasPrice: bigint;
  description: string;
  /** False: not simulated (it depends on an earlier transaction); `budget` is its gas. */
  simulate?: boolean;
  budget?: bigint;
  /** What a revert's error should also say (the contester, the signer's balance, …). */
  revertCtx?: ErrorDetails;
}

/** Encodes, simulates (unless told not to) and prices one transaction; a revert is thrown as its /v1 error. */
export async function buildTx(ctx: Ctx, s: TxSpec): Promise<UnsignedTx> {
  const f = fnOf(s.contract, s.fn);
  const data = encodeFunctionData({ abi: [f], functionName: s.fn, args: s.args } as never);
  const value = s.value ?? 0n;
  const args = Object.fromEntries(f.inputs.map((p, i) => [p.name || String(i), argOut(p, s.args[i])]));
  const call = { contract: s.contract, function: s.fn, args };
  const chainId = chainIdOf(ctx.dep, s.chain);
  if (s.simulate === false) {
    return { chainId, to: s.to, data, value, gas: s.budget ?? FILE_CLAIM_BUDGET, gasPrice: s.gasPrice, description: s.description, call, simulated: false };
  }
  const r = await ctx.chain.simulate(s.chain, { from: s.from, to: s.to, data, ...(value > 0n ? { value } : {}) });
  if (!r.ok) throw revertError(decodeRevert(s.chain, s.contract, r.data), s.revertCtx);
  const [num, den] = MARGIN[s.chain];
  let gas = (r.gas * num + den - 1n) / den;
  const floor = GAS_FLOORS[s.fn];
  if (floor !== undefined && gas < floor) gas = floor;
  return { chainId, to: s.to, data, value, gas, gasPrice: s.gasPrice, description: s.description, call, simulated: true };
}

export interface AnswerSpec {
  action: ActionName;
  chain: ChainName;
  from: Address;
  claimId: Hex | null;
  transactions: UnsignedTx[];
  summary: string;
  amounts: Amount[];
  changes: string[];
  statusAfter: string | null;
  notes: string[];
  builtAt: bigint;
  notAfter: bigint | null;
  readBack: string;
  input: Record<string, unknown>;
}

export function answer(ctx: Ctx, a: AnswerSpec): ActionAnswer {
  const gas = a.transactions.reduce((s, t) => s + t.gas, 0n);
  const amount = a.transactions.reduce((s, t) => s + t.gas * t.gasPrice, 0n);
  const gasPrice = a.transactions[a.transactions.length - 1]?.gasPrice ?? 0n;
  const simulated = a.transactions.every((t) => t.simulated);
  const unit = a.chain === 'hedera' ? WEIBAR : ETH;
  return {
    action: a.action,
    chain: a.chain,
    chainId: chainIdOf(ctx.dep, a.chain),
    from: a.from,
    claimId: a.claimId,
    transactions: a.transactions,
    preview: {
      summary: a.summary,
      amounts: a.amounts,
      fee: { amount, decimals: unit.decimals, symbol: unit.symbol, display: feeText(amount, unit), gas, gasPrice, basis: simulated ? 'estimate' : 'budget' },
      changes: a.changes,
      statusAfter: a.statusAfter,
      notes: a.notes,
    },
    simulated,
    builtAt: a.builtAt,
    notAfter: a.notAfter,
    readBack: a.readBack,
    input: a.input,
  };
}
