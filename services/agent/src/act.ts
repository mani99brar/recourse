// One user action through the status API, as the agent's and the shop's commands run it: build it
// with POST /v1/actions/{name}, check the answer is exactly the call the command means, print the
// preview, and with --send sign each transaction with the role's own key, send them in order and
// read the result back through the API. Exit codes: 0 done (or dry run passed), 2 refused (a typed
// API error, or an answer that is not the intended call), 1 error.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { erc20Abi, getAddress, type Abi, type Address, type Hex, type LocalAccount } from 'viem';
import { ARBITRUM_SEPOLIA_CHAIN_ID, addressBook, claimIdOf } from '@recourse/shared';
import { loadSigner } from '@recourse/shared/node';
import type { Journal } from '@recourse/records';
import { deploymentsDir, loadAbi, publicClientFor, readHederaDeployment, type HederaDeployment } from '../../shop/src/chain.js';
import { KEY_FILE_ENV, type PartySide } from '../../shop/src/claim-actions.js';
import type { FileClaimInput, FilingJournalRow } from '../../shop/src/filing.js';
import {
  SendStopped,
  V1Failure,
  deploymentProblems,
  explorerLink,
  failureLines,
  previewLines,
  readBack,
  sameCallGas,
  signAndSend,
  signingProblems,
  stateLines,
  statusApiUrl,
  v1Client,
  viemRpc,
  type ActionName,
  type BuiltAction,
  type ChainRpc,
  type IntendedCall,
  type ReadBody,
  type V1Client,
  type V1Params,
} from './status-api.js';

type Env = Record<string, string | undefined>;

/** A reason to stop before anything is built or signed, printed as is; exit 2. */
export class Refused extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join('; '));
    this.name = 'Refused';
  }
}

export interface Printer {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const CONSOLE: Printer = { out: (l) => console.log(l), err: (l) => console.error(l) };

export interface ActionRun {
  /** The command's name, for messages. */
  tool: string;
  client: V1Client;
  action: ActionName;
  body: Record<string, unknown>;
  account: LocalAccount;
  chainId: number;
  claimId: Hex | null;
  /** The calls this command means to make, given the answer (fileClaim: with or without its approve). */
  calls: (resp: BuiltAction) => IntendedCall[];
  send: boolean;
  /** The RPC the transactions go out through; opened only to send. */
  rpc: () => Promise<ChainRpc>;
  print?: Printer;
  readBackTimeoutMs?: number;
  receiptTimeoutMs?: number;
  /** A refusal that means the work is already done (a claim already filed): the line to print, exit 0. */
  alreadyDone?: (e: V1Failure) => string | null;
  /** Problems found, with a hint of why (file-claim: the API's topic index may be behind). */
  hint?: (problems: string[]) => string | null;
  onSigned?: (i: number, s: { hash: Hex; nonce: number; raw: Hex }) => void;
  onMined?: (i: number, m: { hash: Hex; status: 'success' | 'reverted'; blockNumber: bigint }) => void;
}

export interface ActionResult {
  code: 0 | 1 | 2;
  resp: BuiltAction | null;
  hashes: Hex[];
  after: ReadBody | null;
  done?: boolean;
}

export async function runAction(run: ActionRun): Promise<ActionResult> {
  const { out, err } = run.print ?? CONSOLE;
  let resp: BuiltAction;
  try {
    resp = await run.client.post(run.action, run.body);
  } catch (error) {
    if (!(error instanceof V1Failure)) throw error;
    const done = run.alreadyDone?.(error);
    if (done) {
      out(done);
      return { code: 0, resp: null, hashes: [], after: null, done: true };
    }
    for (const line of failureLines(error)) err(`${run.tool}: ${line}`);
    return { code: error.refused ? 2 : 1, resp: null, hashes: [], after: null };
  }
  for (const line of previewLines(resp)) out(line);
  const problems = signingProblems(resp, { action: run.action, from: run.account.address, chainId: run.chainId, claimId: run.claimId, calls: run.calls(resp) });
  if (problems.length > 0) {
    err(`${run.tool}: refused: the API's answer is not the call this command makes, so nothing is signed:`);
    for (const p of problems) err(`  - ${p}`);
    const hint = run.hint?.(problems);
    if (hint) err(`  ${hint}`);
    return { code: 2, resp, hashes: [], after: null };
  }
  if (!run.send) {
    out('dry run: the answer is the intended call and the API simulated it against the latest block; nothing signed; rerun with --send');
    return { code: 0, resp, hashes: [], after: null };
  }

  const rpc = await run.rpc();
  let hashes: Hex[];
  try {
    hashes = await signAndSend(resp, {
      account: run.account,
      rpc,
      ...(run.receiptTimeoutMs !== undefined ? { receiptTimeoutMs: run.receiptTimeoutMs } : {}),
      regas: async (tx) => sameCallGas(resp, await run.client.post(run.action, run.body), tx),
      onSigned: (i, s) => {
        run.onSigned?.(i, s);
        out(`step ${i + 1}: signed ${s.hash} (nonce ${s.nonce}); sending`);
      },
      onMined: (i, m) => {
        run.onMined?.(i, m);
        out(`step ${i + 1}: ${m.status === 'success' ? 'mined' : 'REVERTED'} in block ${m.blockNumber}`);
      },
    });
  } catch (error) {
    if (!(error instanceof SendStopped)) throw error;
    err(`${run.tool}: stopped: ${error.message}`);
    for (const h of error.hashes) err(`  sent before stopping: ${h}`);
    return { code: 1, resp, hashes: error.hashes, after: null };
  }
  for (const h of hashes) {
    const link = explorerLink(resp.chainId, h);
    out(`sent ${h}${link ? ` ${link}` : ''}`);
  }
  out(`reading back ${resp.readBack} through the status API`);
  const rb = await readBack(run.client, resp, hashes, { timeoutMs: run.readBackTimeoutMs ?? 180_000 });
  if (rb.body) for (const line of stateLines(rb.body, hashes)) out(line);
  if (!rb.shows) out(`the status API does not show the change yet; read ${run.client.base}${resp.readBack} again later`);
  return { code: 0, resp, hashes, after: rb.body };
}

/** The exit code and message for a failure before or around runAction. */
export function exitFor(tool: string, error: unknown, print: Printer = CONSOLE): number {
  if (error instanceof Refused) {
    for (const line of error.lines) print.err(`${tool}: ${line}`);
    return 2;
  }
  if (error instanceof V1Failure) {
    for (const line of failureLines(error)) print.err(`${tool}: ${line}`);
    return error.refused ? 2 : 1;
  }
  print.err(`${tool}: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}

/** `--wait <seconds>` for the read-back, 180 when not given. */
export function waitMs(v: string | undefined): number {
  if (v === undefined) return 180_000;
  if (!/^[0-9]+$/.test(v)) throw new Error('--wait: whole seconds');
  return Number(v) * 1000;
}

// ------------------------------------------------------------------ Hedera

export interface HederaSide {
  deployment: HederaDeployment;
  account: LocalAccount;
  client: V1Client;
  params: V1Params;
  claimsAbi: Abi;
  vaultAbi: Abi;
  /** HEDERA_RPC_URL_1, for sending. */
  rpc: () => Promise<ChainRpc>;
}

/**
 * The Hedera deployment this checkout names (hedera.json, or the *.local.json HEDERA_LOCAL_FILE
 * names), the signer, and the status API, after checking the API serves the same contracts.
 */
export async function openHedera(env: Env, account: LocalAccount, fetcher: typeof fetch = fetch): Promise<HederaSide> {
  const deployment = readHederaDeployment({ env });
  const client = v1Client(statusApiUrl(env), fetcher);
  const params = (await client.get<{ params: V1Params }>('/v1/params')).params;
  const problems = deploymentProblems(params, { chain: 'hedera', chainId: deployment.chainId, claims: deployment.claims, vault: deployment.vault });
  if (problems.length > 0) throw new Refused([`the status API at ${client.base} is not on this checkout's contracts (${deployment.file}):`, ...problems.map((p) => `  - ${p}`)]);
  return {
    deployment,
    account,
    client,
    params,
    claimsAbi: loadAbi('RecourseClaims', env),
    vaultAbi: loadAbi('DepositVault', env),
    rpc: async () => {
      const url = env.HEDERA_RPC_URL_1;
      if (!url) throw new Error('HEDERA_RPC_URL_1 is not set');
      return rpcAt(url, deployment.chainId);
    },
  };
}

/** The RPC at `url` for `chainId`, to send through. */
export function rpcAt(url: string, chainId: number): ChainRpc {
  return viemRpc(publicClientFor(url, chainId));
}

/** The side's signer from its keystore (PLATFORM_KEY_FILE or SHOP_KEY_FILE). */
export function sideSigner(env: Env, side: PartySide): LocalAccount {
  return loadSigner(KEY_FILE_ENV[side], env);
}

/** A claim-only call on RecourseClaims (contest, closeUncontested, expireClaim, settle, sendToCourt, resend). */
export function claimsCall(h: Pick<HederaSide, 'deployment' | 'claimsAbi'>, functionName: string, claimId: Hex): IntendedCall {
  return { contract: 'RecourseClaims', to: h.deployment.claims, abi: h.claimsAbi, functionName, args: [claimId] };
}

/**
 * fileClaim's calls: fileClaim with exactly the shop's own input (its order nonce and platform, the
 * refs it reads off the records topic, the basket it was paid and the net loss), after an approve
 * of exactly the court fee to the vault on the deployment's token when the API says one is needed.
 */
export function fileClaimCalls(h: Pick<HederaSide, 'deployment' | 'claimsAbi'>, input: FileClaimInput, courtFee: bigint, steps: number): IntendedCall[] {
  const file: IntendedCall = {
    contract: 'RecourseClaims',
    to: h.deployment.claims,
    abi: h.claimsAbi,
    functionName: 'fileClaim',
    args: [input.orderNonce, input.platform, input.refs, input.basketUsdc, input.netLossUsdc],
  };
  if (steps < 2) return [file];
  return [{ contract: 'VaultToken', to: h.deployment.usdc, abi: erc20Abi as Abi, functionName: 'approve', args: [h.deployment.vault, courtFee] }, file];
}

/** The court fee the claims contract charges now, from /v1/params. */
export function courtFeeOf(params: V1Params): bigint {
  const fee = params.params?.claims?.courtFeeUsdc;
  if (typeof fee !== 'string' || !/^[0-9]+$/.test(fee)) throw new Error('/v1/params has no court fee');
  return BigInt(fee);
}

/**
 * The shop's fileClaim through the API, for file-claim and live-order. The body carries the shop's
 * own order nonce, platform, basket and net loss, so the API refuses (basket_mismatch) a basket
 * other than the one the shop was paid. Each signed transaction, its receipt and the filing are
 * journaled in the shop's claims journal (the caller holds its lock). A claim already filed answers
 * claim_exists and nothing is sent.
 */
export async function fileClaimRun(
  h: HederaSide,
  input: FileClaimInput & { orderId: Hex },
  o: { send: boolean; journal: Journal<FilingJournalRow>; allowUnpacked?: boolean; print?: Printer; readBackTimeoutMs?: number },
): Promise<ActionResult & { claimId: Hex }> {
  const claimId = claimIdOf(BigInt(h.deployment.chainId), h.deployment.claims, input.orderId);
  const fee = courtFeeOf(h.params);
  const at = () => new Date().toISOString();
  let steps: ('approve' | 'file')[] = [];
  const r = await runAction({
    tool: 'file-claim',
    client: h.client,
    action: 'fileClaim',
    body: {
      from: h.account.address,
      platform: input.platform,
      orderNonce: input.orderNonce,
      basketUsdc: input.basketUsdc.toString(),
      netLossUsdc: input.netLossUsdc.toString(),
      ...(o.allowUnpacked ? { allowUnpacked: true } : {}),
    },
    account: h.account,
    chainId: h.deployment.chainId,
    claimId,
    calls: (resp) => {
      steps = resp.transactions.map((t) => (t.call.function === 'approve' ? 'approve' : 'file'));
      return fileClaimCalls(h, input, fee, resp.transactions.length);
    },
    send: o.send,
    rpc: h.rpc,
    ...(o.print ? { print: o.print } : {}),
    ...(o.readBackTimeoutMs !== undefined ? { readBackTimeoutMs: o.readBackTimeoutMs } : {}),
    alreadyDone: (e) => (e.code === 'claim_exists' ? `claim ${claimId} is already filed; nothing to send` : null),
    hint: (problems) =>
      problems.some((p) => p.includes('refs'))
        ? "The refs differ from this shop's own reading of the records topic: the status API's index may be behind. Try again in a minute."
        : null,
    onSigned: (i, s) => o.journal.append({ type: 'signed', at: at(), claimId, orderId: input.orderId, step: steps[i] ?? 'file', txHash: s.hash, nonce: s.nonce, raw: s.raw }),
    onMined: (i, m) => o.journal.append({ type: 'mined', at: at(), claimId, step: steps[i] ?? 'file', txHash: m.hash, status: m.status, blockNumber: m.blockNumber.toString() }),
  });
  if (r.done) o.journal.append({ type: 'filed', at: at(), claimId, orderId: input.orderId, txHash: null, existing: true });
  else if (r.code === 0 && r.hashes.length > 0) o.journal.append({ type: 'filed', at: at(), claimId, orderId: input.orderId, txHash: r.hashes.at(-1)!, existing: false });
  return { ...r, claimId };
}

// ------------------------------------------------------------------ Arbitrum

export interface ArbitrumDeployment {
  chainId: number;
  recourseCase: Address;
  evidenceModule: Address;
  file: string;
}

/** `arbitrum.json`, or the *.local.json ARBITRUM_LOCAL_FILE names, in the deployments directory. */
export function readArbitrumDeployment(env: Env = process.env): ArbitrumDeployment {
  const name = env.ARBITRUM_LOCAL_FILE ?? 'arbitrum.json';
  if (name !== 'arbitrum.json' && !/^[A-Za-z0-9_.-]+\.local\.json$/.test(name)) throw new Error(`deployment: ${name} must be arbitrum.json or a bare *.local.json name`);
  const file = join(deploymentsDir(env), name);
  if (!existsSync(file)) throw new Error(`deployment: ${file} does not exist`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { chainId: number; contracts: { case: { address: string } }; outside?: { evidenceModule?: string } };
  if (!name.endsWith('.local.json') && raw.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID) throw new Error(`deployment: ${file} is not for Arbitrum Sepolia`);
  return {
    chainId: raw.chainId,
    recourseCase: getAddress(raw.contracts.case.address),
    evidenceModule: getAddress(raw.outside?.evidenceModule ?? addressBook.arbitrum.evidenceModule),
    file,
  };
}
