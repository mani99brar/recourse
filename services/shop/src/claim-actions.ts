// A claim's later steps on Hedera, for the platform and the shop: contesting a pre-check inside the
// contest window, and withdrawing credit from DepositVault. Reads, the checks the contracts make
// (so a refusal reads well before anything is signed), a simulate that names any revert, and a send.
//
// Contesting moves no USDC: the court fee is escrowed from the shop when the claim is filed.

import { encodeFunctionData, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { Answer, ClaimStatus } from '@recourse/shared';
import { loadSigner } from '@recourse/shared/node';
import { chainClients, loadAbi, readHederaDeployment, type ChainClients, type HederaDeployment } from './chain.js';
import { explainRevert, revertOf, statusName, withErrorsOf, type Revert } from './reverts.js';

export type PartySide = 'platform' | 'shop';

export interface RecourseContracts {
  claims: Address;
  vault: Address;
  claimsAbi: Abi;
  vaultAbi: Abi;
}

export interface ClaimView {
  claimId: Hex;
  orderId: Hex;
  status: number;
  shop: Address;
  platform: Address;
  basketUsdc: bigint;
  netLossUsdc: bigint;
  filedAt: bigint;
  preCheckedAt: bigint;
  gap: number;
  answer: number;
  contestedBy: Address;
}

export interface ClaimParams {
  contestWindow: bigint;
  claimTimeout: bigint;
  courtFeeUsdc: bigint;
}

export interface EscrowView {
  /** 0 none, 1 open, 2 closed. */
  state: number;
  shop: Address;
  platform: Address;
  amount: bigint;
  refunded: bigint;
}

export async function readClaim(client: PublicClient, c: RecourseContracts, claimId: Hex): Promise<ClaimView> {
  const raw = (await client.readContract({ address: c.claims, abi: c.claimsAbi, functionName: 'getClaim', args: [claimId] })) as {
    orderId: Hex;
    shop: Address;
    platform: Address;
    basketUsdc: bigint;
    netLossUsdc: bigint;
    filedAt: bigint | number;
    preCheckedAt: bigint | number;
    gap: number;
    answer: number;
    contestedBy: Address;
    status: number;
  };
  return {
    claimId,
    orderId: raw.orderId,
    status: Number(raw.status),
    shop: raw.shop,
    platform: raw.platform,
    basketUsdc: raw.basketUsdc,
    netLossUsdc: raw.netLossUsdc,
    filedAt: BigInt(raw.filedAt),
    preCheckedAt: BigInt(raw.preCheckedAt),
    gap: Number(raw.gap),
    answer: Number(raw.answer),
    contestedBy: raw.contestedBy,
  };
}

export async function readClaimParams(client: PublicClient, c: RecourseContracts): Promise<ClaimParams> {
  const p = (await client.readContract({ address: c.claims, abi: c.claimsAbi, functionName: 'params' })) as {
    contestWindow: bigint | number;
    claimTimeout: bigint | number;
    courtFeeUsdc: bigint;
  };
  return { contestWindow: BigInt(p.contestWindow), claimTimeout: BigInt(p.claimTimeout), courtFeeUsdc: p.courtFeeUsdc };
}

export async function readEscrow(client: PublicClient, c: RecourseContracts, claimId: Hex): Promise<EscrowView> {
  const e = (await client.readContract({ address: c.vault, abi: c.vaultAbi, functionName: 'escrowOf', args: [claimId] })) as EscrowView;
  return { state: Number(e.state), shop: e.shop, platform: e.platform, amount: e.amount, refunded: e.refunded };
}

export async function readCredit(client: PublicClient, c: RecourseContracts, account: Address): Promise<bigint> {
  return (await client.readContract({ address: c.vault, abi: c.vaultAbi, functionName: 'creditOf', args: [account] })) as bigint;
}

/** The latest block's timestamp: the clock the contracts compare against. */
export async function chainTime(client: PublicClient): Promise<bigint> {
  return (await client.getBlock({ blockTag: 'latest' })).timestamp;
}

/** The side that may contest: the one the pre-check answer went against (the shop unless it named the platform). */
export function contestingSide(answer: number): PartySide {
  return answer === Answer.Platform ? 'platform' : 'shop';
}

/** The last second a PreChecked claim can be contested (inclusive). */
export function contestClosesAt(claim: ClaimView, params: ClaimParams): bigint {
  return claim.preCheckedAt + params.contestWindow;
}

/**
 * When the claim can be expired: Filed claims from filing, Contested and AtCourt claims from the
 * pre-check, each plus the claim timeout. Null when it cannot expire (PreChecked waits for a
 * contest or `closeUncontested`; the other states are final or settling).
 */
export function expiresAt(claim: ClaimView, params: ClaimParams): bigint | null {
  if (claim.status === ClaimStatus.Filed) return claim.filedAt + params.claimTimeout;
  if (claim.status === ClaimStatus.Contested || claim.status === ClaimStatus.AtCourt) return claim.preCheckedAt + params.claimTimeout;
  return null;
}

/** Why `caller` may not contest the claim as `side` at chain time `now`, or null when it may. */
export function contestRefusal(input: { claim: ClaimView; params: ClaimParams; now: bigint; side: PartySide; caller: Address }): string | null {
  const { claim, params, now, side, caller } = input;
  if (claim.status === ClaimStatus.None) return `no claim ${claim.claimId} on this deployment`;
  if (claim.status !== ClaimStatus.PreChecked) return `the claim is ${statusName(claim.status)}; only a PreChecked claim can be contested`;
  const closesAt = contestClosesAt(claim, params);
  if (now > closesAt) return `the contest window closed at ${isoOf(closesAt)} (chain time ${isoOf(now)})`;
  const losing = contestingSide(claim.answer);
  if (side !== losing) return `the pre-check went against the ${losing}, so the ${side} is not the losing side and cannot contest`;
  const expected = side === 'platform' ? claim.platform : claim.shop;
  if (caller.toLowerCase() !== expected.toLowerCase()) return `the ${side} key is ${caller}, but this claim's ${side} is ${expected}`;
  return null;
}

export function isoOf(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** A call the contract would refuse, with its revert decoded. */
export class CallRefused extends Error {
  constructor(
    readonly functionName: string,
    readonly revert: Revert,
  ) {
    super(`${functionName} would revert: ${explainRevert(revert)}`);
    this.name = 'CallRefused';
  }
}

/** `eth_call` as `from`; the call's result, or CallRefused naming the revert. */
export async function simulateCall(client: PublicClient, from: Address, call: ContractCall): Promise<unknown> {
  try {
    const { result } = await client.simulateContract({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args ? [...call.args] : [],
      account: from,
    });
    return result;
  } catch (error) {
    const revert = revertOf(error);
    if (revert) throw new CallRefused(call.functionName, revert);
    throw error;
  }
}

/**
 * Signs with the clients' account and sends: legacy gas price, a margin on Hedera's gas estimate.
 * Throws when the receipt says reverted.
 */
export async function sendCall(clients: ChainClients, call: ContractCall, receiptTimeoutMs = 120_000): Promise<TransactionReceipt> {
  const { publicClient, walletClient, account, chain, hedera } = clients;
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ? [...call.args] : [] });
  const estimate = await publicClient.estimateGas({ account: account.address, to: call.address, data });
  const gas = hedera ? (estimate * 13n) / 10n : estimate + estimate / 5n;
  const gasPrice = await publicClient.getGasPrice();
  const hash = await walletClient.sendTransaction({ account, chain, to: call.address, data, gas, gasPrice, type: 'legacy' });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs });
  if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted in ${hash}`);
  return receipt;
}

/** `contest(claimId)`, with the vault's errors in the ABI so any revert decodes by name. */
export function contestCall(c: RecourseContracts, claimId: Hex): ContractCall {
  return { address: c.claims, abi: withErrorsOf(c.claimsAbi, c.vaultAbi), functionName: 'contest', args: [claimId] };
}

export function withdrawCreditCall(c: RecourseContracts): ContractCall {
  return { address: c.vault, abi: c.vaultAbi, functionName: 'withdrawCredit', args: [] };
}

/** The keystore env var that signs for each side. */
export const KEY_FILE_ENV: Record<PartySide, string> = { platform: 'PLATFORM_KEY_FILE', shop: 'SHOP_KEY_FILE' };

export interface PartyChain {
  deployment: HederaDeployment;
  contracts: RecourseContracts;
  clients: ChainClients;
}

/**
 * The deployment (hedera.json, or the *.local.json HEDERA_LOCAL_FILE names), the side's signer
 * from its keystore, and clients on HEDERA_RPC_URL_1, after checking the RPC serves the
 * deployment's chain.
 */
export async function openPartyChain(env: Record<string, string | undefined>, side: PartySide): Promise<PartyChain> {
  const deployment = readHederaDeployment({ env });
  const rpcUrl = env.HEDERA_RPC_URL_1;
  if (!rpcUrl) throw new Error('HEDERA_RPC_URL_1 is not set');
  const account = loadSigner(KEY_FILE_ENV[side], env);
  const clients = chainClients({ rpcUrl, chainId: deployment.chainId, account });
  const served = await clients.publicClient.getChainId();
  if (served !== deployment.chainId) throw new Error(`HEDERA_RPC_URL_1 serves chain ${served}; ${deployment.file} is for chain ${deployment.chainId}`);
  return {
    deployment,
    clients,
    contracts: {
      claims: deployment.claims,
      vault: deployment.vault,
      claimsAbi: loadAbi('RecourseClaims', env),
      vaultAbi: loadAbi('DepositVault', env),
    },
  };
}
