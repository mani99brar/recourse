// An agent company's deposit, built in the browser: approve the vault on the vault token, then
// postDeposit (open to anyone; it pulls the approved amount), and the bonded mark in words from the
// status API's party read. The vault and token addresses come from GET /v1/params (addresses.vault,
// addresses.usdc); nothing here signs. Setting the required deposit is the vault owner's call alone.
import { encodeFunctionData, type Address } from 'viem';
import type { UnsignedTx } from './actions.js';
import { CALL_ABIS } from './calls.js';
import { HEDERA_CHAIN_ID } from './chains.js';
import { usdc, when } from './format.js';
import { depositState, type Standing } from '../pages/Party.js';
import type { VaultToken } from '@recourse/shared';

/**
 * postDeposit's gas limit while its approve has not mined (its transferFrom fails until then, so it
 * cannot be simulated): a cap, estimated again once approve has mined. Hedera bills the gas used.
 */
export const POST_DEPOSIT_BUDGET = '400000';

/** The vault token on this deployment is the testnet mock; the step descriptions name it so. */
const VAULT_LABEL = { label: 'mUSDC (testnet mock)' } as const;

/** approve(vault, amount) on the vault token; gas is estimated by the signing panel before the preview. */
export function buildApprove(token: Address, vault: Address, amount: bigint): UnsignedTx {
  return {
    chainId: HEDERA_CHAIN_ID,
    to: token,
    data: encodeFunctionData({ abi: CALL_ABIS.VaultToken, functionName: 'approve', args: [vault, amount] }),
    value: '0',
    gas: '0',
    gasPrice: '0',
    description: `Let the deposit vault take ${usdc(amount, VAULT_LABEL)} from your wallet, once.`,
    call: { contract: 'VaultToken', function: 'approve', args: { spender: vault, amount: amount.toString() } },
    simulated: false,
  };
}

/** postDeposit(platform, amount): the vault pulls `amount` from the signer into `platform`'s deposit. */
export function buildPostDeposit(vault: Address, platform: Address, amount: bigint): UnsignedTx {
  return {
    chainId: HEDERA_CHAIN_ID,
    to: vault,
    data: encodeFunctionData({ abi: CALL_ABIS.DepositVault, functionName: 'postDeposit', args: [platform, amount] }),
    value: '0',
    gas: POST_DEPOSIT_BUDGET,
    gasPrice: '0',
    description: `Post ${usdc(amount, VAULT_LABEL)} into the vault as the deposit of ${platform}.`,
    call: { contract: 'DepositVault', function: 'postDeposit', args: { platform, amount: amount.toString() } },
    simulated: false,
  };
}

/** Why an approve + postDeposit pair should not be signed: the approve must be for the vault and the same amount. */
export function depositProblems(txs: readonly UnsignedTx[]): string[] {
  const approve = txs.find((t) => t.call.function === 'approve');
  const post = txs.find((t) => t.call.function === 'postDeposit');
  const out: string[] = [];
  if (!post) return out;
  if (approve && String(approve.call.args.spender).toLowerCase() !== post.to.toLowerCase()) out.push('The approve is for another contract than the deposit vault.');
  if (approve && String(approve.call.args.amount) !== String(post.call.args.amount)) out.push('The approve is for a different amount from the deposit.');
  return out;
}

/** The fields of GET /v1/parties/{address} (Party in openapi.json) the mark reads; the vault fields are null when not read. */
export type PartyDeposit = Pick<Standing, 'balance' | 'required' | 'inGoodStanding' | 'topUpDeadline' | 'exitRequestedAt'>;

export interface BondedMark {
  state: 'bonded' | 'top-up' | 'not-bonded' | 'unknown';
  words: string;
}

/**
 * An agent company's deposit in one state and a sentence, from the party read (unwrapped by
 * getRead, or the raw `{ party, meta }`). Every figure is the vault's, as the status API read it.
 */
export function bondedMark(read: PartyDeposit | { party: PartyDeposit } | null | undefined, token?: Pick<VaultToken, 'label'>): BondedMark {
  const p = read && 'party' in read ? read.party : read;
  if (!p || p.inGoodStanding === null || p.balance === null || p.required === null) {
    return {
      state: 'unknown',
      words: 'The deposit is not read. The status service reads the vault only for addresses in its party map: a new agent company appears once the operator adds it there.',
    };
  }
  const held = `holds ${usdc(p.balance, token)} of ${usdc(p.required, token)} required`;
  if (p.exitRequestedAt && p.exitRequestedAt !== '0') return { state: 'not-bonded', words: `Not bonded: it asked to leave the vault on ${when(p.exitRequestedAt)}; ${held}.` };
  if (p.required === '0') {
    return { state: 'not-bonded', words: `Not bonded: no required deposit is set for it yet (only the vault's owner, the operator, can set one); it holds ${usdc(p.balance, token)}.` };
  }
  const s = depositState(p);
  if (s === 'bonded') {
    const due = p.topUpDeadline && p.topUpDeadline !== '0';
    return due
      ? { state: 'top-up', words: `Top-up due: it ${held}, and stays in good standing until ${when(p.topUpDeadline)}.` }
      : { state: 'bonded', words: `Bonded: it ${held}.` };
  }
  if (s === 'due') return { state: 'not-bonded', words: `Not bonded: its top-up time ran out at ${when(p.topUpDeadline)}; it ${held}.` };
  return { state: 'not-bonded', words: `Not bonded: it ${held}.` };
}
