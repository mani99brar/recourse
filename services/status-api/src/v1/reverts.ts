// Revert bytes from a simulated call, decoded against every contract the call can reach on its
// chain (a vault error surfaces through RecourseClaims.fileClaim), and mapped to the /v1 error
// codes as `x-recourse-revert-map` in openapi.json lists them (a test keeps the two equal).

import { decodeErrorResult, toFunctionSelector, type Abi, type Hex } from 'viem';
import { CASE_ABI, CLAIMS_ABI, VAULT_ABI, type ContractLabel } from '../abi/deployed.js';
import type { ChainName } from '../chain.js';
import { V1Error, type ErrorCode, type ErrorDetails, type Revert } from './errors.js';

type AbiError = Extract<Abi[number], { type: 'error' }>;

const STANDARD: Abi = [
  { type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
];

const ON_CHAIN: Record<ChainName, ContractLabel[]> = {
  hedera: ['RecourseClaims', 'DepositVault'],
  arbitrum: ['RecourseCase'],
};
const ABIS: Partial<Record<ContractLabel, Abi>> = { RecourseClaims: CLAIMS_ABI, DepositVault: VAULT_ABI, RecourseCase: CASE_ABI };

/** Errors the vault raises inside a claims call: attributed to the vault even when the claims ABI has the same name. */
const VAULT_ERRORS = new Set(['ExitDue', 'TransferFailed', 'NotAssociatedYet', 'EscrowExists', 'NoCredit', 'NotAssociated']);

function signature(e: AbiError): string {
  return `${e.name}(${e.inputs.map((i: { type: string }) => i.type).join(',')})`;
}

const selectors = new Map<string, { contract: ContractLabel; item: AbiError }[]>();
for (const [label, abi] of Object.entries(ABIS) as [ContractLabel, Abi][]) {
  for (const item of abi) {
    if (item.type !== 'error') continue;
    const sel = toFunctionSelector(signature(item));
    const list = selectors.get(sel) ?? [];
    list.push({ contract: label, item });
    selectors.set(sel, list);
  }
}

function str(v: unknown): string {
  if (typeof v === 'bigint' || typeof v === 'number') return v.toString();
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

/** The revert as `{contract, name, args}`; `name` is 'reverted' when the node gave no reason. */
export function decodeRevert(chain: ChainName, called: ContractLabel, data: Hex | null): Revert {
  if (data === null || data.length < 10) return { contract: called, name: 'reverted', args: [] };
  const sel = data.slice(0, 10).toLowerCase();
  const found = (selectors.get(sel) ?? []).filter((c) => ON_CHAIN[chain].includes(c.contract));
  if (found.length > 0) {
    const pick =
      found.find((c) => c.contract === 'DepositVault' && VAULT_ERRORS.has(c.item.name)) ?? found.find((c) => c.contract === called) ?? found[0]!;
    try {
      const d = decodeErrorResult({ abi: [pick.item], data });
      return { contract: pick.contract, name: d.errorName, args: (d.args ?? []).map(str) };
    } catch {
      return { contract: pick.contract, name: pick.item.name, args: [] };
    }
  }
  try {
    const d = decodeErrorResult({ abi: STANDARD, data });
    return { contract: called, name: d.errorName, args: (d.args ?? []).map(str) };
  } catch {
    return { contract: called, name: 'reverted', args: [] };
  }
}

/** One row of the revert map: a contract error and the code it answers. */
export interface RevertRule {
  contract: ContractLabel;
  error: string;
  code: ErrorCode;
}

export const REVERT_MAP: RevertRule[] = [
  { contract: 'RecourseClaims', error: 'WrongStatus(uint8)', code: 'wrong_status' },
  { contract: 'RecourseClaims', error: 'WindowClosed(uint256)', code: 'window_closed' },
  { contract: 'RecourseClaims', error: 'WindowOpen(uint256)', code: 'window_open' },
  { contract: 'RecourseClaims', error: 'NotContester()', code: 'not_contester' },
  { contract: 'RecourseClaims', error: 'NotExpired(uint256)', code: 'not_expired' },
  { contract: 'RecourseClaims', error: 'ClaimExists(bytes32)', code: 'claim_exists' },
  { contract: 'RecourseClaims', error: 'SameParty()', code: 'same_party' },
  { contract: 'RecourseClaims', error: 'ZeroBasket()', code: 'zero_basket' },
  { contract: 'RecourseClaims', error: 'BasketTooLarge()', code: 'basket_too_large' },
  { contract: 'RecourseClaims', error: 'NetLossAboveBasket()', code: 'net_loss_above_basket' },
  { contract: 'RecourseClaims', error: 'MissingOrdered()', code: 'no_ordered_record' },
  { contract: 'RecourseClaims', error: 'ResendTooSoon(uint256)', code: 'resend_too_soon' },
  { contract: 'RecourseClaims', error: 'MaxSendsReached()', code: 'max_sends_reached' },
  { contract: 'RecourseClaims', error: 'WrongMode(uint8)', code: 'bridge_unavailable' },
  { contract: 'RecourseClaims', error: 'PeerNotSet()', code: 'bridge_unavailable' },
  { contract: 'RecourseClaims', error: 'LinkShort(uint256,uint256)', code: 'contract_underfunded' },
  { contract: 'RecourseClaims', error: 'NativeShort(uint256,uint256)', code: 'contract_underfunded' },
  { contract: 'DepositVault', error: 'ExitDue()', code: 'exit_due' },
  { contract: 'DepositVault', error: 'TransferFailed()', code: 'insufficient_balance' },
  { contract: 'DepositVault', error: 'NotAssociatedYet()', code: 'vault_not_ready' },
  { contract: 'DepositVault', error: 'EscrowExists(bytes32)', code: 'claim_exists' },
  { contract: 'DepositVault', error: 'NoCredit()', code: 'no_credit' },
  { contract: 'DepositVault', error: 'NotAssociated(address)', code: 'not_associated' },
  { contract: 'RecourseCase', error: 'WrongState(bytes32,uint8)', code: 'case_wrong_state' },
  { contract: 'RecourseCase', error: 'CapReached()', code: 'cap_reached' },
  { contract: 'RecourseCase', error: 'FeePoolLow(uint256,uint256)', code: 'contract_underfunded' },
  { contract: 'RecourseCase', error: 'InsufficientLink(uint256,uint256)', code: 'contract_underfunded' },
  { contract: 'RecourseCase', error: 'InsufficientValue(uint256,uint256)', code: 'insufficient_value' },
  { contract: 'RecourseCase', error: 'SendTooSoon(uint64)', code: 'resend_too_soon' },
  { contract: 'RecourseCase', error: 'MaxSendsReached()', code: 'max_sends_reached' },
  { contract: 'RecourseCase', error: 'PeerNotSet()', code: 'bridge_unavailable' },
  { contract: 'RecourseCase', error: 'RelayDisabled()', code: 'bridge_unavailable' },
];

const RULES = new Map(REVERT_MAP.map((r) => [`${r.contract}:${r.error.slice(0, r.error.indexOf('('))}`, r]));

export const CLAIM_STATUS_NAMES = ['None', 'Filed', 'PreChecked', 'Contested', 'AtCourt', 'Ruled', 'Settled', 'Closed', 'Expired'] as const;
export const CASE_STATE_NAMES = ['none', 'received', 'opened', 'refile_pending', 'ruled', 'relayed', 'stale'] as const;

export function iso(seconds: bigint | string): string {
  const n = Number(seconds);
  return Number.isFinite(n) && n < 8.64e12 ? new Date(n * 1000).toISOString().replace('.000Z', 'Z') : String(seconds);
}

/** What the caller knows that the revert does not carry (the contester, the signer's balance, …). */
export type RevertContext = ErrorDetails;

/** The /v1 error for a decoded revert. */
export function revertError(r: Revert, ctx: RevertContext = {}): V1Error {
  const rule = RULES.get(`${r.contract}:${r.name}`);
  const a = r.args;
  const d: ErrorDetails = {};
  const revert = { contract: r.contract, name: r.name, args: r.args };
  if (!rule) return new V1Error('call_reverted', r.name === 'reverted' ? 'The call reverted without a reason.' : `The call reverted with ${r.contract}.${r.name}.`, { ...d, revert });
  const code = rule.code;
  let message: string;
  switch (r.name) {
    case 'WrongStatus': {
      const s = Number(a[0] ?? 0);
      d.status = s;
      d.statusName = CLAIM_STATUS_NAMES[s] ?? 'None';
      message = `The claim is ${d.statusName}, which does not allow this call.`;
      break;
    }
    case 'WindowClosed':
      d.closesAt = a[0];
      message = `The contest window closed at ${iso(a[0] ?? '0')}.`;
      break;
    case 'WindowOpen':
      d.closesAt = a[0];
      message = `The contest window is open until ${iso(a[0] ?? '0')}.`;
      break;
    case 'NotContester':
      message = 'Only the side the pre-check went against may contest.';
      if (ctx.contester) d.contester = ctx.contester;
      break;
    case 'NotExpired':
      d.expiresAfter = a[0];
      message = `The claim's timeout has not passed; it can expire after ${iso(a[0] ?? '0')}.`;
      break;
    case 'ClaimExists':
    case 'EscrowExists':
      d.claimId = a[0];
      message = 'A claim for this order is already filed.';
      break;
    case 'SameParty':
      message = 'The platform cannot be the signer itself.';
      break;
    case 'ZeroBasket':
      message = 'The basket is zero.';
      break;
    case 'BasketTooLarge':
      message = 'The basket is above the contract limit.';
      break;
    case 'NetLossAboveBasket':
      message = 'The net loss is above the basket.';
      break;
    case 'MissingOrdered':
      message = 'The claim has no ordered record.';
      break;
    case 'ResendTooSoon':
    case 'SendTooSoon':
      d.availableAt = a[0];
      message = `The last send was too recent; the next one is possible from ${iso(a[0] ?? '0')}.`;
      break;
    case 'MaxSendsReached':
      message = 'The message was already sent the most times allowed.';
      break;
    case 'WrongMode':
      d.mode = Number(a[0] ?? 0);
      message = 'The bridge mode does not send this message.';
      break;
    case 'PeerNotSet':
      message = 'The bridge has no peer set.';
      break;
    case 'RelayDisabled':
      message = 'The relay is off.';
      break;
    case 'LinkShort':
    case 'NativeShort':
    case 'FeePoolLow':
    case 'InsufficientLink':
      d.have = a[0];
      d.need = a[1];
      d.asset = r.name === 'NativeShort' ? 'HBAR' : r.name === 'FeePoolLow' ? 'ETH' : 'LINK';
      message = `The contract that pays this fee holds too little ${d.asset}.`;
      break;
    case 'InsufficientValue':
      d.sent = a[0];
      d.need = a[1];
      message = 'The value sent is below the CCIP fee, which rose since the build; build again.';
      break;
    case 'ExitDue':
      message = "The platform's exit from the deposit vault is due, so it takes no new claim.";
      break;
    case 'TransferFailed':
      message = 'The signer holds or allows less of the vault token than the court fee.';
      if (ctx.balance !== undefined) d.balance = ctx.balance;
      if (ctx.required !== undefined) d.required = ctx.required;
      break;
    case 'NotAssociatedYet':
      message = 'The vault is not associated with its token yet.';
      break;
    case 'NoCredit':
      message = 'The signer has no credit in the deposit vault.';
      break;
    case 'NotAssociated':
      d.account = a[0];
      message = 'The token refused the transfer to the signer; associate the account with the token first.';
      break;
    case 'WrongState': {
      const s = Number(a[1] ?? 0);
      d.state = s;
      d.stateName = CASE_STATE_NAMES[s] ?? 'unknown';
      message = `The court case is ${d.stateName}, which does not take this call.`;
      break;
    }
    case 'CapReached':
      message = 'The open-case limit is reached; the case opens once a slot frees.';
      break;
    default:
      message = `The call reverted with ${r.contract}.${r.name}.`;
  }
  return new V1Error(code, message, { ...d, revert });
}
