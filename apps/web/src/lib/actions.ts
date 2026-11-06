// The v1 actions, as services/status-api/openapi.json describes them: the same POST /v1/actions/{name}
// the agents call. The API builds unsigned transactions and a preview; it never signs, holds a key or
// broadcasts. This file checks an answer before anything is signed and puts its parts into words.
import type { StatusKey, VaultToken } from '@recourse/shared';
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { ApiFailure, apiUrl, failureFrom } from './api.js';
import { ACTION_CALLS, callProblem } from './calls.js';
import { chainLabel, isOurChain, units } from './chains.js';
import { short, usdc, when } from './format.js';

export const ACTION_NAMES = [
  'fileClaim', 'contest', 'submitEvidence', 'withdrawCredit', 'closeUncontested', 'sendToCourt',
  'resend', 'expireClaim', 'settle', 'openCase', 'refile', 'relayRuling',
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export type Movement = 'escrow' | 'reserve' | 'credit' | 'receive' | 'send' | 'contract_pays' | 'info';

export interface UnsignedTx {
  chainId: number;
  to: Address;
  data: Hex;
  /** Decimal text in the chain's smallest unit (wei; weibar on Hedera). */
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

export interface NativeFee {
  amount: string;
  decimals: number;
  symbol: string;
  display: string;
  gas: string;
  gasPrice: string;
  basis: 'estimate' | 'budget';
}

export interface Preview {
  summary: string;
  amounts: PreviewAmount[];
  fee: NativeFee;
  changes: string[];
  statusAfter: StatusKey | null;
  notes: string[];
}

export interface ActionResponse {
  action: ActionName;
  chain: 'hedera' | 'arbitrum';
  chainId: number;
  from: Address;
  claimId: Hex | null;
  transactions: UnsignedTx[];
  preview: Preview;
  simulated: boolean;
  builtAt: string;
  notAfter: string | null;
  readBack: string;
  input: Record<string, unknown>;
}

/** A preview older than this is built again before signing: fees, allowances and quotes move. */
export const STALE_AFTER_S = 300;

export async function postAction(name: ActionName, body: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<ActionResponse> {
  const ctl = new AbortController();
  // The web server gives the status API 15 s; this leaves room for the hop.
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    let r: Response;
    try {
      r = await fetcher(apiUrl(`/v1/actions/${name}`), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch {
      throw new ApiFailure(0, 'unreachable');
    }
    const json = (await r.json().catch(() => null)) as unknown;
    if (!r.ok) throw failureFrom(r.status, json);
    if (!looksBuilt(json)) throw new ApiFailure(r.status, 'bad_answer');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

const UINT = /^(0|[1-9][0-9]*)$/;
const uint = (v: unknown): boolean => typeof v === 'string' && UINT.test(v);

/** The answer has the contract's shape, down to every number the page turns into a BigInt or a date. */
export function looksBuilt(v: unknown): v is ActionResponse {
  const o = v as Partial<ActionResponse> | null;
  if (!o || typeof o !== 'object' || typeof o.action !== 'string' || typeof o.from !== 'string' || typeof o.chainId !== 'number') return false;
  if (!Array.isArray(o.transactions) || o.transactions.length < 1 || o.transactions.length > 2 || typeof o.readBack !== 'string' || !uint(o.builtAt)) return false;
  if (o.notAfter !== null && !uint(o.notAfter)) return false;
  const txOk = o.transactions.every(
    (t) => !!t && typeof t.chainId === 'number' && typeof t.to === 'string' && typeof t.data === 'string' && uint(t.value) && uint(t.gas) && typeof t.description === 'string' && !!t.call && typeof t.call.contract === 'string' && typeof t.call.function === 'string' && !!t.call.args && typeof t.call.args === 'object',
  );
  const p = o.preview;
  const previewOk =
    !!p && typeof p.summary === 'string' && Array.isArray(p.amounts) && Array.isArray(p.changes) && Array.isArray(p.notes) &&
    p.amounts.every((a) => !!a && typeof a.name === 'string' && uint(a.amount) && Number.isInteger(a.decimals) && typeof a.symbol === 'string') &&
    !!p.fee && uint(p.fee.amount) && uint(p.fee.gas) && Number.isInteger(p.fee.decimals) && typeof p.fee.symbol === 'string';
  return txOk && previewOk;
}

/** Credit that a withdrawal would pay out: read, and above zero. */
export function hasCredit(credit: string | null | undefined): credit is string {
  return typeof credit === 'string' && UINT.test(credit) && BigInt(credit) > 0n;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * The gas the API now estimates for `tx`, from a fresh answer built for the same action and account:
 * only for the same call (network, target, data and value) and only when it was simulated. Null
 * otherwise, and the step keeps the gas it was built with.
 */
export function sameCallGas(resp: ActionResponse, again: ActionResponse, tx: UnsignedTx): string | null {
  if (again.action !== resp.action || !sameAddress(again.from, resp.from)) return null;
  const t = again.transactions.find((x) => x.simulated && x.chainId === tx.chainId && sameAddress(x.to, tx.to) && x.data.toLowerCase() === tx.data.toLowerCase() && x.value === tx.value);
  return t ? t.gas : null;
}

/** A read-back path is one of the API's own /v1 reads, never a URL somewhere else. */
export function readBackPath(path: string): string | null {
  return /^\/v1\/(claims|parties)\/0x[0-9a-fA-F]+$/.test(path) ? path : null;
}

/**
 * Every reason not to sign this answer, in plain words; empty when it may go to the wallet. The
 * answer must be the action asked for, for the account asked for, on a test network, with every
 * transaction's data decoding to the call it shows, no value the preview does not show as sent,
 * and an approve for no more than the court fee.
 */
export function signingProblems(resp: ActionResponse, asked: { name: ActionName; from: string; claimId?: string | null }, nowS: number = Date.now() / 1000): string[] {
  const out: string[] = [];
  if (resp.action !== asked.name) out.push(`The API built ${resp.action}, not ${asked.name}.`);
  if (!sameAddress(resp.from, asked.from)) out.push(`It was built for ${short(resp.from)}, not your account ${short(asked.from)}.`);
  if (asked.claimId && resp.claimId && resp.claimId.toLowerCase() !== asked.claimId.toLowerCase()) out.push('It was built for a different claim.');
  if (!isOurChain(resp.chainId)) out.push(`It is for network ${resp.chainId}; this page signs only on Hedera testnet and Arbitrum Sepolia.`);
  const allowed = ACTION_CALLS[asked.name] ?? [];
  resp.transactions.forEach((tx, i) => {
    const n = resp.transactions.length > 1 ? `Step ${i + 1}` : 'The transaction';
    if (tx.chainId !== resp.chainId) out.push(`${n} is on another network (${tx.chainId}).`);
    if (!isAddress(tx.to) || !isHex(tx.data)) out.push(`${n} has no valid target or data.`);
    else {
      const why = callProblem(tx.data, tx.call);
      if (why) out.push(`${n} does not match the call shown: ${why}.`);
    }
    if (!allowed.includes(`${tx.call.contract}.${tx.call.function}` as (typeof allowed)[number])) out.push(`${n} calls ${tx.call.contract}.${tx.call.function}, which ${asked.name} never needs.`);
    if (tx.call.function === 'approve') {
      const fee = resp.preview.amounts.find((a) => a.name === 'courtFee');
      if (!fee || String(tx.call.args.amount) !== fee.amount) out.push(`${n} approves a different amount from the court fee.`);
    }
  });
  const value = resp.transactions.reduce((s, t) => s + BigInt(t.value || '0'), 0n);
  const shown = resp.preview.amounts.filter((a) => a.movement === 'send').reduce((s, a) => s + BigInt(a.amount), 0n);
  if (value !== shown) out.push('The transactions send a value the preview does not show.');
  if (resp.notAfter !== null && nowS > Number(resp.notAfter)) out.push(`The deadline for this call passed at ${when(resp.notAfter)}.`);
  return out;
}

export function isStale(resp: ActionResponse, nowS: number = Date.now() / 1000): boolean {
  return nowS - Number(resp.builtAt) > STALE_AFTER_S;
}

// ---- words ----

export const ACTION_WORDS: Record<ActionName, string> = {
  fileClaim: 'File the claim',
  contest: 'Contest the finding',
  submitEvidence: 'Add evidence',
  withdrawCredit: 'Withdraw credit',
  closeUncontested: 'Close the claim',
  sendToCourt: 'Send the claim to court',
  resend: 'Resend the message to court',
  expireClaim: 'End the claim',
  settle: 'Settle the claim',
  openCase: 'Open the court case',
  refile: 'File the court case again',
  relayRuling: 'Send the ruling back to Hedera',
};

const AMOUNT_WORDS: Record<string, string> = {
  basket: 'Basket',
  netLoss: 'Net loss claimed',
  handling: 'Handling allowance',
  courtFee: 'Court fee',
  maxPayout: 'Most that can be paid out',
  credit: 'Credit',
  toShop: 'To the shop',
  feeRefund: 'Court fee back to the shop',
  toPool: 'To the court-fee pool',
  ccipFee: 'Cross-chain message fee',
  disputeCost: 'Court case cost',
};

export function amountName(name: string): string {
  return AMOUNT_WORDS[name] ?? name;
}

/** Vault amounts carry the app's token label, so the mock always reads as a testnet mock. */
export function amountText(a: Pick<PreviewAmount, 'amount' | 'decimals' | 'symbol'>): string {
  if (a.decimals === 6 && (a.symbol === 'mUSDC' || a.symbol === 'USDC')) return usdc(a.amount, { label: a.symbol === 'mUSDC' ? 'mUSDC (testnet mock)' : 'USDC' });
  return units(a.amount, a.decimals, a.symbol);
}

/** The API's own sentences (summary, steps, changes, notes) with the mock labelled as the rest of the app labels it. */
export function mockLabelled(text: string): string {
  return text.replace(/\bmUSDC\b(?! \(testnet mock\))/g, 'mUSDC (testnet mock)');
}

/** Who an address is, from the signer's side: "your", "the agent company's", or a short address. */
export function whose(account: string | null, from: string, names: Record<string, string> = {}): string {
  if (account === null) return '';
  if (sameAddress(account, from)) return 'your';
  const n = names[account.toLowerCase()];
  return n ? `${n}'s` : `${short(account)}'s`;
}

export function movementWords(a: Pick<PreviewAmount, 'movement' | 'account'>, from: string, names: Record<string, string> = {}): string {
  const w = whose(a.account, from, names) || 'an';
  switch (a.movement) {
    case 'escrow':
      return `Leaves ${w} wallet into the claim's escrow`;
    case 'reserve':
      return `Held from ${w} deposit in the vault`;
    case 'credit':
      return `Added to ${w} credit in the vault`;
    case 'receive':
      return `Arrives in ${w} wallet`;
    case 'send':
      return `Paid from ${w} wallet with the transaction`;
    case 'contract_pays':
      return 'Paid by the contract from its own balance';
    default:
      return 'Shown for information; nothing moves';
  }
}

export function feeWords(fee: NativeFee, chainId: number): string[] {
  const out = [`At most ${units(fee.amount, fee.decimals, fee.symbol)} on ${chainLabel(chainId)}, for ${BigInt(fee.gas).toLocaleString('en-US')} gas at the price when this was built.`];
  out.push(fee.basis === 'budget' ? 'Part of it is a fixed budget: a later step cannot be simulated until the step before it has mined. Once it has, this page asks for an estimate and uses it when it is lower.' : 'Estimated by simulating the call against the latest block.');
  if (chainId === 296) out.push('Hedera charges for the gas the call uses, so this, from the gas limit, is the most it can cost.');
  out.push('Your wallet shows the final fee before you sign, and may set its own price.');
  return out;
}

const UPSTREAM_WORDS: Record<string, string> = {
  index: 'its index', hedera_rpc: 'Hedera', arbitrum_rpc: 'Arbitrum', mirror: 'the Hedera mirror node', ipfs: 'IPFS',
  shop: 'the shop service', precheck: 'the pre-check service', docket: 'the docket service', status_api: 'the status service',
};

type Words = (d: Record<string, unknown>, ctx: { from?: string; token?: Pick<VaultToken, 'label'> | undefined }) => string;
const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** One plain sentence per v1 error code (every code in the contract), plus the client's own. */
export const ERROR_WORDS: Record<string, Words> = {
  bad_json: () => 'The API could not read the request. Reload the page and try again.',
  missing_field: (d) => `A required field is missing${d.field ? `: ${s(d.field)}` : ''}.`,
  invalid_field: (d) => `${d.field ? `The field ${s(d.field)}` : 'A field'} is not valid${d.reason ? `: ${s(d.reason)}` : ''}.`,
  unknown_field: (d) => `The API does not take the field ${s(d.field) || 'sent'}. Reload the page and try again.`,
  not_contester: (d, c) => `Only ${d.contester ? short(s(d.contester)) : 'the side the pre-check went against'} can contest this claim${c.from ? `, and your wallet is ${short(c.from)}` : ''}. Switch to that account in your wallet.`,
  not_found: (d) => (d.resource === 'claim' ? 'No such claim yet. A claim filed moments ago appears once the index reaches it.' : d.resource === 'order' ? 'No such order.' : d.resource === 'case' ? 'There is no court case for this claim yet.' : 'The API has no such claim, order or case.'),
  method_not_allowed: () => 'The status service does not take this request. It may not build actions yet.',
  read_only: () => 'The status service does not build actions yet: it only serves reads.',
  payload_too_large: () => 'The request is over 64 KB. Shorten the text and try again.',
  same_party: () => 'The agent company is your own account. A shop cannot file a claim against itself.',
  order_id_mismatch: () => 'The order nonce and agent company do not give this order id for your account. Check both, and that your wallet is the shop that took the order.',
  order_nonce_unknown: () => 'The shop service does not know this order. Enter the order nonce and the agent company address the order was paid with.',
  not_paid: () => 'The shop service has no accepted payment for this order.',
  no_ordered_record: () => 'The records topic has no ordered record for this order from its agent company, so there is nothing to claim on yet.',
  ordered_unreadable: () => 'The ordered record does not match its hash or is not a record document, so the basket cannot be read from it.',
  ordered_tx_mismatch: () => 'The ordered record names a different payment from the one the shop settled.',
  no_packed_record: () => 'The records topic has no packing record from the shop. Without one, the pre-check finds against the shop from the packing step on. Tick "File without a packing record" to file anyway.',
  zero_basket: () => 'The basket is zero, so there is nothing to claim.',
  basket_too_large: () => 'The basket is above the most a claim can be for.',
  basket_mismatch: (d, c) => `The basket sent differs from the ordered record${d.derived ? `, which says ${usdc(s(d.derived), c.token)}` : ''}.`,
  net_loss_above_basket: () => 'The net loss cannot be more than the basket.',
  evidence_too_large: (d) => `The evidence is ${s(d.bytes) || 'over the limit in'} bytes; the most is ${s(d.max) || '49152'}. Shorten it.`,
  claim_exists: () => 'A claim for this order is already filed.',
  wrong_status: (d) => `On chain the claim is ${d.statusName ? s(d.statusName) : 'in a state'} that does not allow this now. This page may be a few seconds behind the chain.`,
  window_closed: (d) => `The contest window closed${d.closesAt ? ` at ${when(s(d.closesAt))}` : ''}.`,
  window_open: (d) => `The contest window is still open${d.closesAt ? ` until ${when(s(d.closesAt))}` : ''}, so the claim cannot close yet.`,
  not_expired: (d) => `The claim has not timed out yet${d.expiresAfter ? `; it can be ended after ${when(s(d.expiresAfter))}` : ''}.`,
  exit_due: () => 'The agent company is leaving the deposit vault, so no new claim can be filed against it.',
  insufficient_balance: (d, c) => `Your account holds ${d.balance ? usdc(s(d.balance), c.token) : 'less than'} ${d.required ? `and the court fee is ${usdc(s(d.required), c.token)}` : 'the court fee'}.`,
  no_credit: () => 'This account has no credit to withdraw.',
  not_associated: () => 'The token refused the transfer: the account must be associated with the token first.',
  vault_not_ready: () => 'The deposit vault is not set up with its token yet.',
  resend_too_soon: (d) => `The message was sent too recently${d.availableAt ? `; try again after ${when(s(d.availableAt))}` : ''}.`,
  max_sends_reached: () => 'The message has already been sent the most times allowed.',
  bridge_unavailable: () => 'The link between the chains is off for this call right now.',
  contract_underfunded: (d) => `The contract that pays this fee holds too little${d.asset ? ` ${s(d.asset)}` : ''} to pay it.`,
  insufficient_value: () => 'The cross-chain fee rose since the preview was built. Build it again.',
  case_wrong_state: (d) => `The court case is ${d.stateName ? s(d.stateName) : 'in a state'} that does not take this step.`,
  cap_reached: () => 'The court has as many open cases as it allows; this one opens when a slot frees.',
  no_dispute: () => 'No court dispute is open for this claim and attempt yet, so there is nowhere to file evidence.',
  call_reverted: (d) => {
    const r = d.revert as { contract?: string; name?: string } | undefined;
    return `The contract would refuse this call${r?.name ? ` (${s(r.contract)} ${s(r.name)})` : ''}.`;
  },
  rate_limited: (d) => `Too many requests from this browser. Wait ${d.retryAfterS ? `${s(d.retryAfterS)} seconds` : 'a few seconds'} and try again.`,
  internal: () => 'The API failed unexpectedly. Try again in a moment.',
  upstream_unavailable: (d) => `A source the API needs did not answer${d.upstream ? ` (${UPSTREAM_WORDS[s(d.upstream)] ?? s(d.upstream)})` : ''}. Try again in a moment.`,
  unreachable: () => 'The status service cannot be reached. Try again in a moment.',
  bad_answer: () => 'The API answered in a form this page does not know, so nothing will be signed.',
};

function byStatus(status: number): string {
  if (status === 400) return 'The API refused the request as not valid.';
  if (status === 403) return 'Your account may not do this.';
  if (status === 404) return 'Not found.';
  if (status === 409) return 'The chain does not allow this right now.';
  if (status === 413) return 'The request is too large.';
  if (status === 422) return 'The API refused the input.';
  if (status === 429) return 'Too many requests. Wait a few seconds and try again.';
  return 'The API is not available right now. Try again in a moment.';
}

/** An API failure in words: ours for a known code, else the API's own sentence, else by HTTP status. */
export function errorWords(e: ApiFailure, ctx: { from?: string; token?: Pick<VaultToken, 'label'> | undefined } = {}): string {
  const w = ERROR_WORDS[e.code];
  if (w) return w(e.details, ctx);
  return e.said ?? byStatus(e.status);
}

// ---- read back ----

export interface ClaimRead {
  claim: {
    claimId: string;
    statusKey: StatusKey;
    contest?: { by: string | null };
    court?: { evidence?: { tx: string; attempt: number; time: string; explorer: string | null }[] };
    events?: { name: string; tx: string; chain: string; explorer: string | null }[];
    escrow?: { amount: string; fate: string };
    credited?: string | null;
  };
  meta?: { vaultToken?: Pick<VaultToken, 'label'>; asOf?: Record<string, number | null> };
}
export interface PartyRead {
  party: { address: string; credit: string | null };
  meta?: { vaultToken?: Pick<VaultToken, 'label'>; asOf?: Record<string, number | null> };
}
export type ReadBody = ClaimRead | PartyRead;

/** The read shows the change: an event or evidence from one of the sent transactions, the credit gone down, or the expected status. */
export function readBackShows(resp: ActionResponse, body: ReadBody, hashes: readonly string[]): boolean {
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
