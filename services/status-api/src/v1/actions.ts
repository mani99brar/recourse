// The /v1 actions: each reads the chain at the latest block, refuses with a typed error what the
// contract would refuse, and otherwise answers the unsigned transactions (simulated as `from`) and
// a preview. The checks mirror the contracts' own, in their order; the simulation catches the rest.

import { ClaimStatus, CaseState, externalIdUint, sideOf, type Answer } from '@recourse/shared';
import { keccak256, sha256, stringToBytes, type Address, type Hex } from 'viem';
import { ChainRevert, type CaseNow, type ChainClaim } from '../chain.js';
import { foldClaim } from '../join.js';
import type { StatusService } from '../service.js';
import { answer, buildTx, type ActionAnswer, type ActionName, type Ctx } from './build.js';
import { V1Error, notFound, upstream } from './errors.js';
import { ETH, LINK, TINYBAR, amountOf, tokenText, type Unit } from './format.js';
import { fileClaim } from './filing.js';
import { CASE_STATE_NAMES, CLAIM_STATUS_NAMES, iso } from './reverts.js';
import { parseBody, type BodySpec } from './validate.js';

export const EVIDENCE_MAX_BYTES = 49_152;

const CLAIM_BODY: BodySpec = { from: { kind: 'address', required: true }, claimId: { kind: 'bytes32', required: true } };
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BRIDGE_NONE = 2;

export interface ActionEnv {
  svc: StatusService;
  ctx: Ctx;
}

function wrongStatus(status: number): V1Error {
  const statusName = CLAIM_STATUS_NAMES[status] ?? 'None';
  return new V1Error('wrong_status', `The claim is ${statusName}, which does not allow this call.`, { status, statusName });
}

function caseWrongState(state: number): V1Error {
  const stateName = CASE_STATE_NAMES[state] ?? 'unknown';
  return new V1Error('case_wrong_state', `The court case is ${stateName}, which does not take this call.`, { state, stateName });
}

function vaultUnit(env: ActionEnv): Unit {
  return { decimals: env.svc.d.deployments.token.decimals, symbol: env.svc.d.deployments.token.symbol };
}

function claimsAddress(env: ActionEnv): Address {
  const a = env.svc.d.deployments.claims;
  if (!a) throw upstream('hedera_rpc', { reason: 'no claims contract configured' });
  return a;
}

function vaultAddress(env: ActionEnv): Address {
  const a = env.svc.d.deployments.vault;
  if (!a) throw upstream('hedera_rpc', { reason: 'no vault contract configured' });
  return a;
}

function caseAddress(env: ActionEnv): Address {
  const a = env.svc.d.deployments.caseAddress;
  if (!a) throw upstream('arbitrum_rpc', { reason: 'no case contract configured' });
  return a;
}

/** The claim as read from the chain; not_found when the chain has none. */
function known(claim: ChainClaim, claimId: Hex): ChainClaim {
  if (claim.status === ClaimStatus.None) throw notFound('claim', claimId);
  return claim;
}

function caseStateOfIndex(env: ActionEnv, claimId: Hex): string | null {
  const v = env.svc.d.store.live.get(claimId)?.caseView;
  return v ? (CASE_STATE_NAMES[v.state] ?? 'unknown') : null;
}

function claimInput(claimId: Hex, status: number, caseState: string | null) {
  return { claimId, status, statusName: CLAIM_STATUS_NAMES[status] ?? 'None', caseState };
}

const readBackOf = (claimId: Hex) => `/v1/claims/${claimId}`;

interface Terms {
  contestWindow: bigint;
  claimTimeout: bigint;
  /** False: the claims contract has no per-claim terms and checks against its current params(). */
  frozen: boolean;
}

/**
 * The contest window and claim timeout the claims contract checks this claim against: the claim's
 * own, fixed at filing. A claims contract from before per-claim terms has no `claimTermsOf` (the
 * call reverts) and checks every claim against its current `params()`, so those stand in. An RPC
 * fault is still thrown: it answers upstream_unavailable, never a guessed window.
 */
async function termsOf(env: ActionEnv, claimId: Hex): Promise<Terms> {
  const c = env.ctx.chain;
  try {
    const t = await c.claimTerms(claimId);
    return { contestWindow: t.contestWindow, claimTimeout: t.claimTimeout, frozen: true };
  } catch (e) {
    if (!(e instanceof ChainRevert)) throw e;
  }
  const now = await c.claimsNow();
  return { contestWindow: now.contestWindow, claimTimeout: now.claimTimeout, frozen: false };
}

const PARAMS_TERMS_NOTE = 'This claims contract keeps no terms per claim: it checks against its current parameters, not ones fixed when the claim was filed.';

// ------------------------------------------------------------------ Hedera, one claim

async function contest(env: ActionEnv, raw: unknown): Promise<ActionAnswer> {
  const p = parseBody(raw, CLAIM_BODY);
  const from = p.from as Address;
  const claimId = p.claimId as Hex;
  const c = env.ctx.chain;
  const [claim, terms, head, gasPrice, fee] = await Promise.all([c.claim(claimId), termsOf(env, claimId), c.head('hedera'), c.gasPrice('hedera'), c.escrowOf(claimId)]);
  known(claim, claimId);
  if (claim.status !== ClaimStatus.PreChecked) throw wrongStatus(claim.status);
  const closesAt = claim.preCheckedAt + terms.contestWindow;
  if (head.timestamp > closesAt) {
    throw new V1Error('window_closed', `The contest window closed at ${iso(closesAt)}.`, { closesAt });
  }
  const contester = claim.answer === 1 ? claim.platform : claim.shop;
  if (from !== contester) {
    throw new V1Error('not_contester', `Only the ${claim.answer === 1 ? 'platform' : 'shop'} may contest this finding.`, { contester });
  }
  const tx = await buildTx(env.ctx, {
    chain: 'hedera', contract: 'RecourseClaims', to: claimsAddress(env), fn: 'contest', args: [claimId], from, gasPrice,
    description: 'Contest the pre-check finding: the claim goes to court.', revertCtx: { contester },
  });
  const unit = vaultUnit(env);
  return answer(env.ctx, {
    action: 'contest', chain: 'hedera', from, claimId, transactions: [tx],
    summary: `Contest the pre-check finding against the ${sideOf(claim.answer as Answer)}; the claim goes to court on Arbitrum.`,
    amounts: [amountOf('courtFee', fee, unit, 'info', claim.shop)],
    changes: [
      'The claim is contested (status contested).',
      'Anyone may then send it to court; the keeper does so on its own.',
      `The ${tokenText(fee, unit)} court fee escrowed at filing stays in escrow until the claim ends.`,
    ],
    statusAfter: 'contested',
    notes: [`The contest window closes at ${iso(closesAt)}: the transaction must mine by then.`, ...(terms.frozen ? [] : [PARAMS_TERMS_NOTE])],
    builtAt: head.timestamp, notAfter: closesAt, readBack: readBackOf(claimId),
    input: claimInput(claimId, claim.status, caseStateOfIndex(env, claimId)),
  });
}

async function closeUncontested(env: ActionEnv, raw: unknown): Promise<ActionAnswer> {
  const p = parseBody(raw, CLAIM_BODY);
  const from = p.from as Address;
  const claimId = p.claimId as Hex;
  const c = env.ctx.chain;
  const [claim, terms, head, gasPrice, settle] = await Promise.all([c.claim(claimId), termsOf(env, claimId), c.head('hedera'), c.gasPrice('hedera'), c.previewSettle(claimId)]);
  known(claim, claimId);
  if (claim.status !== ClaimStatus.PreChecked) throw wrongStatus(claim.status);
  const closesAt = claim.preCheckedAt + terms.contestWindow;
  if (head.timestamp <= closesAt) {
    throw new V1Error('window_open', `The contest window is open until ${iso(closesAt)}.`, { closesAt });
  }
  const tx = await buildTx(env.ctx, {
    chain: 'hedera', contract: 'RecourseClaims', to: claimsAddress(env), fn: 'closeUncontested', args: [claimId], from, gasPrice,
    description: 'Close the claim uncontested: the court fee is refunded, and the shop is credited if the finding was against the platform.',
  });
  const unit = vaultUnit(env);
  return answer(env.ctx, {
    action: 'closeUncontested', chain: 'hedera', from, claimId, transactions: [tx],
    summary: settle.toShop > 0n
      ? `Close the claim uncontested: ${tokenText(settle.toShop, unit)} is credited to the shop and the court fee is refunded.`
      : 'Close the claim uncontested: nothing is owed to the shop and the court fee is refunded.',
    amounts: [amountOf('toShop', settle.toShop, unit, 'credit', claim.shop), amountOf('feeRefund', settle.refund, unit, 'credit', claim.shop)],
    changes: [
      'The claim closes uncontested (status closed_uncontested).',
      settle.toShop > 0n
        ? `${tokenText(settle.toShop, unit)} is credited to the shop from the platform's deposit, up to what the deposit covers.`
        : 'Nothing is owed to the shop: the finding was not against the platform.',
      `The ${tokenText(settle.refund, unit)} court fee is refunded to the shop as credit.`,
      'The shop takes its credit out with withdrawCredit.',
    ],
    statusAfter: 'closed_uncontested',
    notes: terms.frozen ? [] : [PARAMS_TERMS_NOTE],
    builtAt: head.timestamp, notAfter: null, readBack: readBackOf(claimId),
    input: claimInput(claimId, claim.status, caseStateOfIndex(env, claimId)),
  });
}

function ccipUnit(feeToken: Address): Unit {
  return feeToken === ZERO_ADDRESS ? TINYBAR : LINK;
}

async function sendOrResend(env: ActionEnv, raw: unknown, action: 'sendToCourt' | 'resend'): Promise<ActionAnswer> {
  const p = parseBody(raw, CLAIM_BODY);
  const from = p.from as Address;
  const claimId = p.claimId as Hex;
  const c = env.ctx.chain;
  const [claim, head, gasPrice, now] = await Promise.all([c.claim(claimId), c.head('hedera'), c.gasPrice('hedera'), c.claimsNow()]);
  known(claim, claimId);
  const notes: string[] = [];
  if (action === 'sendToCourt') {
    if (claim.status !== ClaimStatus.Contested) throw wrongStatus(claim.status);
    if (now.bridgeMode !== BRIDGE_NONE && now.peer === ZERO_ADDRESS) throw new V1Error('bridge_unavailable', 'The bridge has no peer set.', {});
    if (now.bridgeMode === BRIDGE_NONE) notes.push('The bridge mode sends nothing: the claim moves to court without a CCIP message, and the ruling relayer records the ruling.');
  } else {
    if (claim.status !== ClaimStatus.AtCourt) throw wrongStatus(claim.status);
    if (now.bridgeMode === BRIDGE_NONE) throw new V1Error('bridge_unavailable', 'The bridge mode does not send this message.', { mode: now.bridgeMode });
    const availableAt = claim.lastSendAt + now.resendGap;
    if (head.timestamp < availableAt) {
      throw new V1Error('resend_too_soon', `The last send was too recent; the next one is possible from ${iso(availableAt)}.`, { availableAt });
    }
    if (claim.sendCount >= now.maxSends) throw new V1Error('max_sends_reached', 'The message was already sent the most times allowed.', {});
    if (now.peer === ZERO_ADDRESS) throw new V1Error('bridge_unavailable', 'The bridge has no peer set.', {});
  }
  const fee = now.bridgeMode === BRIDGE_NONE ? 0n : await c.quoteSend(claimId);
  const claims = claimsAddress(env);
  const tx = await buildTx(env.ctx, {
    chain: 'hedera', contract: 'RecourseClaims', to: claims, fn: action, args: [claimId], from, gasPrice,
    description: action === 'sendToCourt' ? 'Send the contested claim to court over CCIP; the claims contract pays the fee.' : 'Send the claim to court again over CCIP; the claims contract pays the fee.',
  });
  notes.push('The keeper sends on its own; this is for when it has not.');
  const unit = ccipUnit(now.feeToken);
  return answer(env.ctx, {
    action, chain: 'hedera', from, claimId, transactions: [tx],
    summary: action === 'sendToCourt' ? 'Send the claim to court on Arbitrum; the claims contract pays the CCIP fee.' : `Send the claim to court again (send ${claim.sendCount + 1} of at most ${now.maxSends}); the claims contract pays the CCIP fee.`,
    amounts: [amountOf('ccipFee', fee, unit, 'contract_pays', claims)],
    changes: [
      action === 'sendToCourt' ? 'The claim is at court (status at_court).' : 'The claim stays at court; one more copy of its message is sent.',
      now.bridgeMode === BRIDGE_NONE ? 'No message is sent.' : `The claims contract pays about ${tokenText(fee, unit)} for the CCIP message from its own balance.`,
      'The court case opens on Arbitrum once the message lands; whichever copy lands first counts.',
    ],
    statusAfter: 'at_court',
    notes,
    builtAt: head.timestamp, notAfter: null, readBack: readBackOf(claimId),
    input: claimInput(claimId, claim.status, caseStateOfIndex(env, claimId)),
  });
}

async function expireClaim(env: ActionEnv, raw: unknown): Promise<ActionAnswer> {
  const p = parseBody(raw, CLAIM_BODY);
  const from = p.from as Address;
  const claimId = p.claimId as Hex;
  const c = env.ctx.chain;
  const [claim, terms, head, gasPrice, fee, reserves] = await Promise.all([
    c.claim(claimId), termsOf(env, claimId), c.head('hedera'), c.gasPrice('hedera'), c.escrowOf(claimId), c.vaultReserves(),
  ]);
  known(claim, claimId);
  const s = claim.status;
  if (s !== ClaimStatus.Filed && s !== ClaimStatus.Contested && s !== ClaimStatus.AtCourt) throw wrongStatus(s);
  const expiresAfter = (s === ClaimStatus.Filed ? claim.filedAt : claim.preCheckedAt) + terms.claimTimeout;
  if (head.timestamp <= expiresAfter) {
    throw new V1Error('not_expired', `The claim's timeout has not passed; it can expire after ${iso(expiresAfter)}.`, { expiresAfter });
  }
  const tx = await buildTx(env.ctx, {
    chain: 'hedera', contract: 'RecourseClaims', to: claimsAddress(env), fn: 'expireClaim', args: [claimId], from, gasPrice,
    description: 'Expire the claim: it never reached a ruling, so the court fee is refunded in full.',
  });
  const notes: string[] = [];
  const folded = foldClaim(env.svc.d.store.eventsOf(claimId));
  const live = env.svc.d.store.live.get(claimId)?.caseView;
  if ((folded && folded.relayed.length > 0) || (live && (live.state === CaseState.Ruled || live.state === CaseState.Relayed))) {
    notes.push('A ruling is on its way back over CCIP: expiring the claim now discards it.');
  }
  if (!terms.frozen) notes.push(PARAMS_TERMS_NOTE);
  const unit = vaultUnit(env);
  return answer(env.ctx, {
    action: 'expireClaim', chain: 'hedera', from, claimId, transactions: [tx],
    summary: `Expire the claim; the ${tokenText(fee, unit)} court fee is refunded to the shop.`,
    amounts: [amountOf('feeRefund', fee, unit, 'credit', claim.shop)],
    changes: [
      'The claim expires (status expired).',
      `The ${tokenText(fee, unit)} court fee is refunded to the shop as credit; nothing is paid from the platform's deposit.`,
      ...(reserves ? ["The part of the platform's deposit reserved for this claim is released."] : []),
    ],
    statusAfter: 'expired',
    notes,
    builtAt: head.timestamp, notAfter: null, readBack: readBackOf(claimId),
    input: claimInput(claimId, claim.status, caseStateOfIndex(env, claimId)),
  });
}

async function settle(env: ActionEnv, raw: unknown): Promise<ActionAnswer> {
  const p = parseBody(raw, CLAIM_BODY);
  const from = p.from as Address;
  const claimId = p.claimId as Hex;
  const c = env.ctx.chain;
  const [claim, head, gasPrice, s] = await Promise.all([c.claim(claimId), c.head('hedera'), c.gasPrice('hedera'), c.previewSettle(claimId)]);
  known(claim, claimId);
  if (claim.status !== ClaimStatus.Ruled) throw wrongStatus(claim.status);
  const tx = await buildTx(env.ctx, {
    chain: 'hedera', contract: 'RecourseClaims', to: claimsAddress(env), fn: 'settle', args: [claimId], from, gasPrice,
    description: 'Settle the ruled claim: the shop is credited what the ruling owes it and the escrowed fee goes to the pool.',
  });
  const unit = vaultUnit(env);
  return answer(env.ctx, {
    action: 'settle', chain: 'hedera', from, claimId, transactions: [tx],
    summary: s.toShop > 0n ? `Settle the claim: ${tokenText(s.toShop, unit)} is credited to the shop.` : 'Settle the claim: nothing is owed to the shop.',
    amounts: [amountOf('toShop', s.toShop, unit, 'credit', claim.shop), amountOf('toPool', s.toPool, unit, 'info', null)],
    changes: [
      'The claim is settled (status settled).',
      s.toShop > 0n ? `${tokenText(s.toShop, unit)} is credited to the shop from the platform's deposit; a part the deposit cannot cover is recorded as not covered.` : 'Nothing is paid from the platform\'s deposit.',
      `The ${tokenText(s.toPool, unit)} escrowed court fee goes to the pool.`,
    ],
    statusAfter: 'settled',
    notes: [],
    builtAt: head.timestamp, notAfter: null, readBack: readBackOf(claimId),
    input: claimInput(claimId, claim.status, caseStateOfIndex(env, claimId)),
  });
}

async function withdrawCredit(env: ActionEnv, raw: unknown): Promise<ActionAnswer> {
  const p = parseBody(raw, { from: { kind: 'address', required: true } });
  const from = p.from as Address;
  const c = env.ctx.chain;
  const [credit, head, gasPrice] = await Promise.all([c.creditOf(from), c.head('hedera'), c.gasPrice('hedera')]);
  if (credit === 0n) throw new V1Error('no_credit', 'The signer has no credit in the deposit vault.', {});
  const tx = await buildTx(env.ctx, {
    chain: 'hedera', contract: 'DepositVault', to: vaultAddress(env), fn: 'withdrawCredit', args: [], from, gasPrice,
    description: 'Withdraw your whole credit from the deposit vault to your account.', revertCtx: { account: from },
  });
  const unit = vaultUnit(env);
  return answer(env.ctx, {
    action: 'withdrawCredit', chain: 'hedera', from, claimId: null, transactions: [tx],
    summary: `Withdraw ${tokenText(credit, unit)} of credit from the deposit vault to your account.`,
    amounts: [amountOf('credit', credit, unit, 'receive', from)],
    changes: [`Your vault credit goes to 0 and ${tokenText(credit, unit)} arrives in your account.`],
    statusAfter: null,
    notes: env.svc.d.deployments.token.mode === 'circle' ? ['On Circle USDC your account must be associated with the token, or the vault answers not_associated.'] : [],
    builtAt: head.timestamp, notAfter: null, readBack: `/v1/parties/${from}`,
    input: { account: from, credit },
  });
}

// ------------------------------------------------------------------ Arbitrum

/** The Hedera claim's status for the input block: the chain when it answers, else the index. */
async function hederaStatusOf(env: ActionEnv, claimId: Hex): Promise<number> {
  const indexed = () => foldClaim(env.svc.d.store.eventsOf(claimId))?.status ?? 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Only informative here: a slow Hedera relay never holds up an Arbitrum action.
  const late = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(indexed()), HEDERA_STATUS_WAIT_MS);
  });
  try {
    return await Promise.race([env.ctx.chain.claim(claimId).then((c) => c.status), late]);
  } catch {
    return indexed();
  } finally {
    clearTimeout(timer);
  }
}

const HEDERA_STATUS_WAIT_MS = 3_000;

function caseKnown(k: CaseNow, claimId: Hex): CaseNow {
  if (k.state === CaseState.None) throw notFound('case', claimId);
  return k;
}

async function submitEvidence(env: ActionEnv, raw: unknown): Promise<ActionAnswer> {
  const p = parseBody(raw, {
    from: { kind: 'address', required: true },
    claimId: { kind: 'bytes32', required: true },
    attempt: { kind: 'attempt' },
    name: { kind: 'name', required: true },
    description: { kind: 'text', required: true },
    fileURI: { kind: 'fileURI' },
  });
  const from = p.from as Address;
  const claimId = p.claimId as Hex;
  const evidence = JSON.stringify(p.fileURI !== undefined ? { name: p.name, description: p.description, fileURI: p.fileURI } : { name: p.name, description: p.description });
  const bytes = stringToBytes(evidence).length;
  if (bytes > EVIDENCE_MAX_BYTES) {
    throw new V1Error('evidence_too_large', `The evidence is ${bytes} bytes; at most ${EVIDENCE_MAX_BYTES} are taken.`, { bytes, max: EVIDENCE_MAX_BYTES });
  }
  const kase = caseAddress(env);
  const c = env.ctx.chain;
  const [k, head, gasPrice] = await Promise.all([c.caseNow(claimId), c.head('arbitrum'), c.gasPrice('arbitrum')]);
  caseKnown(k, claimId);
  const attempt = (p.attempt as number | undefined) ?? (k.attempts >= 2 ? 2 : 1);
  const disputeId = k.disputeIds[attempt - 1] ?? 0n;
  if (disputeId === 0n) throw new V1Error('no_dispute', `No dispute is open for attempt ${attempt} yet, so there is nowhere to file evidence.`, { attempt });
  const period = await c.period(disputeId);
  const periodName = period === null ? null : (['evidence', 'commit', 'vote', 'appeal', 'execution'][period] ?? null);
  const externalId = externalIdUint(env.svc.d.deployments.arbitrumChainId, kase, claimId, attempt);
  const tx = await buildTx(env.ctx, {
    chain: 'arbitrum', contract: 'EvidenceModule', to: env.svc.d.deployments.outside.evidenceModule, fn: 'submitEvidence', args: [externalId, evidence], from, gasPrice,
    description: `Submit evidence "${String(p.name).slice(0, 60)}" to dispute ${disputeId} (attempt ${attempt}).`,
  });
  const notes: string[] = [];
  if (periodName) notes.push(`The dispute is in its ${periodName} period.`);
  if (periodName && periodName !== 'evidence') notes.push('The court takes evidence in any period, but jurors may already be past reading it.');
  notes.push('The court shows the signing account as the party that submitted it; the API pins nothing.');
  return answer(env.ctx, {
    action: 'submitEvidence', chain: 'arbitrum', from, claimId, transactions: [tx],
    summary: `Add evidence to the claim's Kleros dispute ${disputeId}.`,
    amounts: [],
    changes: ['The evidence appears on the dispute under your account; nothing else changes.'],
    statusAfter: null,
    notes,
    builtAt: head.timestamp, notAfter: null, readBack: readBackOf(claimId),
    input: { claimId, attempt, disputeId, externalId, evidence, byteLength: bytes, sha256: sha256(stringToBytes(evidence)), periodName },
  });
}

/** The ClaimToCourt payload of the claim's ClaimReceived event, checked against the case's hash. */
function payloadOf(env: ActionEnv, claimId: Hex, expected: Hex): Hex {
  for (const e of env.svc.d.store.eventsOf(claimId)) {
    if (e.contract !== 'case' || e.name !== 'ClaimReceived') continue;
    const payload = e.args.payload;
    if (typeof payload === 'string' && payload.length > 2 && keccak256(payload as Hex) === expected.toLowerCase()) return payload as Hex;
  }
  throw upstream('index', { reason: 'the claim\'s ClaimReceived event is not indexed yet' });
}

async function openOrRefile(env: ActionEnv, raw: unknown, action: 'openCase' | 'refile'): Promise<ActionAnswer> {
  const p = parseBody(raw, CLAIM_BODY);
  const from = p.from as Address;
  const claimId = p.claimId as Hex;
  const kase = caseAddress(env);
  const c = env.ctx.chain;
  const [k, court, head, gasPrice, status] = await Promise.all([c.caseNow(claimId), c.courtNow(), c.head('arbitrum'), c.gasPrice('arbitrum'), hederaStatusOf(env, claimId)]);
  caseKnown(k, claimId);
  if (action === 'openCase' && k.state !== CaseState.Received) throw caseWrongState(k.state);
  if (action === 'refile' && (k.state !== CaseState.RefilePending || k.attempts !== 1)) throw caseWrongState(k.state);
  const payload = payloadOf(env, claimId, k.payloadHash);
  const stale = head.timestamp + court.caseDeadline >= k.expiresAt;
  if (!stale) {
    if (action === 'openCase' && court.openCases >= court.maxOpenCases) {
      throw new V1Error('cap_reached', 'The open-case limit is reached; the case opens once a slot frees.', { openCases: court.openCases, maxOpenCases: court.maxOpenCases });
    }
    if (court.feePool < court.costNow) {
      throw new V1Error('contract_underfunded', 'The fee pool holds less than one dispute costs now.', { have: court.feePool, need: court.costNow, asset: 'ETH' });
    }
  }
  const tx = await buildTx(env.ctx, {
    chain: 'arbitrum', contract: 'RecourseCase', to: kase, fn: action, args: [payload], from, gasPrice,
    description: action === 'openCase' ? 'Open the Kleros case for the claim; the fee pool pays the dispute cost.' : 'Refile the case after the court refused to rule; the fee pool pays the dispute cost.',
  });
  const notes = stale
    ? ['No court round is left before the case\'s deadline: this call marks the case stale instead of opening a dispute, and the claim later expires on Hedera.']
    : ['The keeper opens cases on its own; this is for when it has not.'];
  return answer(env.ctx, {
    action, chain: 'arbitrum', from, claimId, transactions: [tx],
    summary: stale ? 'Mark the court case stale: no court round is left before its deadline.' : `${action === 'openCase' ? 'Open' : 'Refile'} the Kleros case (court attempt ${action === 'openCase' ? 1 : 2}); the fee pool pays ${tokenText(court.costNow, ETH)}.`,
    amounts: stale ? [] : [amountOf('disputeCost', court.costNow, ETH, 'contract_pays', kase)],
    changes: stale
      ? ['The case is marked stale; no dispute is created.']
      : [`A Kleros dispute is created (attempt ${action === 'openCase' ? 1 : 2}).`, `${tokenText(court.costNow, ETH)} leaves the case contract's fee pool.`, 'Jurors are drawn; evidence can be submitted to the dispute.'],
    statusAfter: stale ? null : 'at_court',
    notes,
    builtAt: head.timestamp, notAfter: stale ? null : k.expiresAt - court.caseDeadline - 1n, readBack: readBackOf(claimId),
    input: claimInput(claimId, status, CASE_STATE_NAMES[k.state] ?? 'unknown'),
  });
}

async function relayRuling(env: ActionEnv, raw: unknown): Promise<ActionAnswer> {
  const p = parseBody(raw, { ...CLAIM_BODY, payIn: { kind: 'payIn' } });
  const from = p.from as Address;
  const claimId = p.claimId as Hex;
  const native = (p.payIn ?? 'native') === 'native';
  const kase = caseAddress(env);
  const c = env.ctx.chain;
  const [k, court, head, gasPrice, status] = await Promise.all([c.caseNow(claimId), c.courtNow(), c.head('arbitrum'), c.gasPrice('arbitrum'), hederaStatusOf(env, claimId)]);
  caseKnown(k, claimId);
  if (k.state !== CaseState.Ruled && k.state !== CaseState.Relayed) throw caseWrongState(k.state);
  // The case stays Relayed on Arbitrum for good: once the claim is settled or closed on Hedera, a
  // re-relay only spends the CCIP fee.
  if (status === ClaimStatus.Settled || status === ClaimStatus.Closed) throw wrongStatus(status);
  if (court.peer === ZERO_ADDRESS) throw new V1Error('bridge_unavailable', 'The bridge has no peer set.', {});
  if (k.sendCount >= court.maxSends) throw new V1Error('max_sends_reached', 'The ruling was already sent the most times allowed.', {});
  if (k.sendCount > 0) {
    const availableAt = k.lastSendAt + court.resendGap;
    if (head.timestamp < availableAt) throw new V1Error('resend_too_soon', `The last send was too recent; the next one is possible from ${iso(availableAt)}.`, { availableAt });
  }
  const fee = await c.quoteRelay(claimId, native);
  const tx = await buildTx(env.ctx, {
    chain: 'arbitrum', contract: 'RecourseCase', to: kase, fn: 'relayRuling', args: [claimId], from, gasPrice, value: native ? fee : 0n,
    description: native ? 'Relay the ruling to Hedera over CCIP, paying the fee as the value.' : "Relay the ruling to Hedera over CCIP; the case contract's LINK pays the fee.",
  });
  return answer(env.ctx, {
    action: 'relayRuling', chain: 'arbitrum', from, claimId, transactions: [tx],
    summary: native ? `Relay the ruling to Hedera; you pay the ${tokenText(fee, ETH)} CCIP fee as the value.` : "Relay the ruling to Hedera; the case contract pays the CCIP fee in LINK.",
    amounts: [native ? amountOf('ccipFee', fee, ETH, 'send', from) : amountOf('ccipFee', fee, LINK, 'contract_pays', kase)],
    changes: ['The ruling is sent to Hedera over CCIP (case state relayed).', 'Once it lands, the claim is ruled there and anyone may settle it.'],
    statusAfter: null,
    notes: native ? ['The value is exactly the fee quoted now. If the fee rises before the transaction mines, the call fails with insufficient_value: build again.'] : [],
    builtAt: head.timestamp, notAfter: null, readBack: readBackOf(claimId),
    input: claimInput(claimId, status, CASE_STATE_NAMES[k.state] ?? 'unknown'),
  });
}

/** Which chain and contract each action calls; for errors that arise before the call is built. */
export const ACTION_TARGET: Record<ActionName, { chain: 'hedera' | 'arbitrum'; contract: 'RecourseClaims' | 'DepositVault' | 'RecourseCase' | 'EvidenceModule' }> = {
  fileClaim: { chain: 'hedera', contract: 'RecourseClaims' },
  contest: { chain: 'hedera', contract: 'RecourseClaims' },
  submitEvidence: { chain: 'arbitrum', contract: 'EvidenceModule' },
  withdrawCredit: { chain: 'hedera', contract: 'DepositVault' },
  closeUncontested: { chain: 'hedera', contract: 'RecourseClaims' },
  sendToCourt: { chain: 'hedera', contract: 'RecourseClaims' },
  resend: { chain: 'hedera', contract: 'RecourseClaims' },
  expireClaim: { chain: 'hedera', contract: 'RecourseClaims' },
  settle: { chain: 'hedera', contract: 'RecourseClaims' },
  openCase: { chain: 'arbitrum', contract: 'RecourseCase' },
  refile: { chain: 'arbitrum', contract: 'RecourseCase' },
  relayRuling: { chain: 'arbitrum', contract: 'RecourseCase' },
};

export const ACTIONS: Record<ActionName, (env: ActionEnv, body: unknown) => Promise<ActionAnswer>> = {
  fileClaim,
  contest,
  submitEvidence,
  withdrawCredit,
  closeUncontested,
  sendToCourt: (env, b) => sendOrResend(env, b, 'sendToCourt'),
  resend: (env, b) => sendOrResend(env, b, 'resend'),
  expireClaim,
  settle,
  openCase: (env, b) => openOrRefile(env, b, 'openCase'),
  refile: (env, b) => openOrRefile(env, b, 'refile'),
  relayRuling,
};
