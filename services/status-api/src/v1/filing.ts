// fileClaim: what the caller sends (the shop as `from`, the order's platform and nonce, or the order
// id alone for an order this deployment's shop took) and what the API works out itself: the order
// and claim ids, the record refs from its index of the records topic (only the order's own
// platform's and shop's messages count), the basket from the ordered record, the court fee,
// handling, the allowance, and the fault rule's indicative finding on the referenced records.

import {
  canonicalBytes,
  claimIdOf,
  orderIdOf,
  orderWritersFor,
  RECORD_KEYS,
  ruleSlotFromDoc,
  runFaultRule,
  toMicroUsdcEquivalent,
  withSlot,
  type CanonicalValue,
  type RecordKind,
  type RuleInput,
} from '@recourse/shared';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { getJson, HttpError } from '../http.js';
import { within } from '../lastgood.js';
import type { HcsRecord } from '../types.js';
import { answer, buildTx, FILE_CLAIM_BUDGET, type ActionAnswer } from './build.js';
import type { ActionEnv } from './actions.js';
import { V1Error, upstream } from './errors.js';
import { amountOf, tokenText } from './format.js';
import { parseBody } from './validate.js';

const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;
const MAX_BASKET = (1n << 128n) - 1n;
const KIND_ORDERED = 3;
const KIND_PACKED = 4;

interface ShopOrder {
  orderNonce: Hex;
  platform: Address;
  status: string;
  txId: string;
}

/** The shop service's own record of an order: its nonce, platform and the payment it settled. Waited on readWaitMs at most. */
async function shopOrderOf(env: ActionEnv, orderId: Hex): Promise<ShopOrder> {
  const cfg = env.svc.d.cfg;
  let body: unknown;
  try {
    body = await getJson(env.svc.d.fetch, `${cfg.shopUrl}/orders/${orderId}`, cfg.readWaitMs);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new V1Error('order_nonce_unknown', 'The shop service does not know this order: send orderNonce and platform.', {});
    }
    throw upstream('shop');
  }
  const o = (body as { order?: Record<string, unknown> } | null)?.order;
  const pay = o?.payment as { txId?: unknown } | undefined;
  if (!o || typeof o.orderNonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.orderNonce) || typeof o.platform !== 'string' || !isAddress(o.platform, { strict: false })) {
    throw upstream('shop', { reason: 'the shop answered an order without its nonce or platform' });
  }
  return {
    orderNonce: o.orderNonce.toLowerCase() as Hex,
    platform: getAddress(o.platform),
    status: typeof o.status === 'string' ? o.status : '',
    txId: typeof pay?.txId === 'string' ? pay.txId : '',
  };
}

interface Picked {
  refs: { topicNum: bigint; seq: bigint[]; hashes: Hex[] };
  messages: (HcsRecord | null)[];
}

/** Per kind, the earliest message for the order paid by the order's own writer (refsFromMessages' rule). */
function pickRecords(env: ActionEnv, orderId: Hex, platform: Address, shop: Address): Picked {
  const d = env.svc.d;
  const topic = d.cfg.recordsTopic;
  const parties = d.parties();
  if (topic === '') throw upstream('index', { reason: 'no records topic is configured' });
  if (parties === null) throw upstream('index', { reason: 'the party map is not loaded' });
  const messages: (HcsRecord | null)[] = [null, null, null, null, null, null];
  const writers = [0, 1, 2, 3, 4, 5].map((k) => orderWritersFor(parties, k, { platform, shop }));
  for (const r of d.store.hcs.values()) {
    if (r.topic !== topic || r.orderId !== orderId || r.kind < 0 || r.kind > 5) continue;
    if (!writers[r.kind]!.has(r.payer)) continue;
    const cur = messages[r.kind];
    if (!cur || r.seq < cur.seq) messages[r.kind] = r;
  }
  const topicNum = BigInt(topic.split('.').pop() ?? '0');
  return {
    refs: { topicNum, seq: messages.map((m) => BigInt(m?.seq ?? 0)), hashes: messages.map((m) => (m?.hash ?? ZERO32).toLowerCase() as Hex) },
    messages,
  };
}

function topicFresh(env: ActionEnv): boolean {
  const d = env.svc.d;
  const st = d.store.status.hcs;
  return !st.failing && st.indexedThrough !== null && d.nowS() - st.indexedThrough <= d.cfg.lagWarnS.hcs;
}

/**
 * The fault rule on the records the refs name, as the pre-check runs it; null while a document is
 * unavailable. The documents are fetched together, each waited on readWaitMs at most.
 */
async function expectedFinding(env: ActionEnv, orderId: Hex, messages: (HcsRecord | null)[]) {
  const d = env.svc.d;
  const docs = await Promise.all(messages.map((m) => (m ? within(d.docs.get(m.cid, m.hash), d.cfg.readWaitMs, null) : undefined)));
  let input: RuleInput = {};
  for (let k = 0; k < 6; k++) {
    const doc = docs[k];
    if (doc === undefined) continue;
    if (doc === null) return null;
    if (!doc.ok || !doc.canonical || doc.doc === null) continue;
    const slot = ruleSlotFromDoc(k as RecordKind, canonicalBytes(doc.doc as CanonicalValue), orderId);
    if (slot.ok) input = withSlot(input, slot);
  }
  const r = runFaultRule(input);
  return { gap: r.gap, answer: r.answer, side: r.side, reasonKey: r.reasonKey, step: r.step };
}

export async function fileClaim(env: ActionEnv, raw: unknown): Promise<ActionAnswer> {
  const p = parseBody(raw, {
    from: { kind: 'address', required: true },
    platform: { kind: 'address' },
    orderNonce: { kind: 'bytes32' },
    orderId: { kind: 'bytes32' },
    netLossUsdc: { kind: 'uint' },
    basketUsdc: { kind: 'uint' },
    allowUnpacked: { kind: 'bool' },
  });
  const from = p.from as Address;
  let platform = p.platform as Address | undefined;
  let orderNonce = p.orderNonce as Hex | undefined;
  const sentOrderId = p.orderId as Hex | undefined;
  if (platform === undefined || orderNonce === undefined) {
    if (platform !== undefined || orderNonce !== undefined) throw new V1Error('missing_field', `${platform === undefined ? 'platform' : 'orderNonce'} is required with ${platform === undefined ? 'orderNonce' : 'platform'}.`, { field: platform === undefined ? 'platform' : 'orderNonce' });
    if (sentOrderId === undefined) throw new V1Error('missing_field', 'Send platform and orderNonce, or orderId alone.', { field: 'orderNonce' });
  }
  const d = env.svc.d;
  const claims = d.deployments.claims;
  const vault = d.deployments.vault;
  if (!claims || !vault) throw upstream('hedera_rpc', { reason: 'no claims or vault contract configured' });
  if (platform !== undefined && platform === from) throw new V1Error('same_party', 'The platform cannot be the signer itself.', {});
  if (d.store.rebuilding) throw upstream('index', { rebuilding: true });

  let shopOrder: ShopOrder | null = null;
  if (platform === undefined || orderNonce === undefined) {
    shopOrder = await shopOrderOf(env, sentOrderId!);
    platform = shopOrder.platform;
    orderNonce = shopOrder.orderNonce;
    if (platform === from) throw new V1Error('same_party', 'The platform cannot be the signer itself.', {});
  }
  const orderId = orderIdOf(platform, from, orderNonce).toLowerCase() as Hex;
  if (sentOrderId !== undefined && sentOrderId !== orderId) {
    throw new V1Error('order_id_mismatch', 'orderNonce, platform and from do not hash to the orderId sent.', { derivedOrderId: orderId });
  }
  if (shopOrder && (shopOrder.status === 'payer_mismatch' || shopOrder.txId === '')) {
    throw new V1Error('not_paid', 'The shop service has no accepted payment for this order.', {});
  }
  const claimId = claimIdOf(d.deployments.hederaChainId, claims, orderId).toLowerCase() as Hex;

  // The ordered record, and the basket it says was paid.
  const picked = pickRecords(env, orderId, platform, from);
  const fresh = topicFresh(env);
  const ordered = picked.messages[KIND_ORDERED];
  if (!ordered) {
    if (!fresh) throw upstream('index', { reason: 'the records topic is behind or failing' });
    throw new V1Error('no_ordered_record', "The records topic holds no ordered record for this order from the order's own platform.", {});
  }
  const doc = await within(d.docs.get(ordered.cid, ordered.hash), d.cfg.readWaitMs, null);
  if (doc === null) throw upstream('ipfs');
  if (!doc.ok || !doc.canonical || doc.doc === null || typeof doc.doc !== 'object') {
    throw new V1Error('ordered_unreadable', "The ordered record's document does not match its hash or is not a record document.", {});
  }
  const od = doc.doc as Record<string, unknown>;
  const slot = ruleSlotFromDoc(KIND_ORDERED as RecordKind, canonicalBytes(doc.doc as CanonicalValue), orderId);
  let basket: bigint;
  try {
    if (!slot.ok || typeof od.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(od.amount) || typeof od.asset !== 'string') throw new Error('shape');
    basket = toMicroUsdcEquivalent(BigInt(od.amount), od.asset);
  } catch {
    throw new V1Error('ordered_unreadable', 'The ordered record does not say what was paid in a form the basket can be read from.', {});
  }
  if (shopOrder && od.x402TxId !== shopOrder.txId) {
    throw new V1Error('ordered_tx_mismatch', 'The ordered record names a payment other than the one the shop service settled.', {});
  }
  const allowUnpacked = p.allowUnpacked === true;
  if (!picked.messages[KIND_PACKED] && !allowUnpacked) {
    if (!fresh) throw upstream('index', { reason: 'the records topic is behind or failing' });
    throw new V1Error('no_packed_record', 'The topic holds no packed record from the shop; without one the fault rule answers against the shop from its packed step on. Send allowUnpacked: true to file anyway.', {});
  }
  if (basket === 0n) throw new V1Error('zero_basket', 'The basket is zero.', {});
  if (basket > MAX_BASKET) throw new V1Error('basket_too_large', 'The basket is above the contract limit.', {});
  if (p.basketUsdc !== undefined && p.basketUsdc !== basket) {
    throw new V1Error('basket_mismatch', 'basketUsdc differs from the amount the ordered record says was paid.', { derived: basket });
  }
  const netLoss = (p.netLossUsdc as bigint | undefined) ?? basket;
  if (netLoss > basket) throw new V1Error('net_loss_above_basket', 'The net loss is above the basket.', {});

  // The chain: is the claim new, may the vault take it, can the shop pay the fee.
  const c = env.ctx.chain;
  const [onChain, now, handling, token, gate, idFor, head, gasPrice, reserves] = await Promise.all([
    c.claim(claimId),
    c.claimsNow(),
    c.handlingOf(basket),
    c.vaultToken(),
    c.vaultGate(platform),
    c.claimIdFor(platform, from, orderNonce),
    c.head('hedera'),
    c.gasPrice('hedera'),
    c.vaultReserves(),
  ]);
  if (idFor.toLowerCase() !== claimId) throw new V1Error('internal', 'The claims contract derives another claim id than this API; the deployment files do not match the contract.');
  if (onChain.status !== 0) throw new V1Error('claim_exists', 'A claim for this order is already filed.', { claimId });
  if (!gate.usdcAssociated) throw new V1Error('vault_not_ready', 'The vault is not associated with its token yet.', {});
  if (gate.exitRequestedAt !== 0n && head.timestamp >= gate.exitRequestedAt + gate.exitDelay) {
    throw new V1Error('exit_due', "The platform's exit from the deposit vault is due, so it takes no new claim.", {});
  }
  const fee = now.courtFeeUsdc;
  const { balance, allowance } = await c.tokenOf(token, from, vault);
  if (balance < fee) {
    throw new V1Error('insufficient_balance', 'The signer holds less of the vault token than the court fee.', { balance, required: fee });
  }
  const approveNeeded = allowance < fee;
  const unit = { decimals: d.deployments.token.decimals, symbol: d.deployments.token.symbol };
  const maxPayout = netLoss + handling + fee;
  const refs = picked.refs;
  const txs = [];
  if (approveNeeded) {
    txs.push(
      await buildTx(env.ctx, {
        chain: 'hedera', contract: 'VaultToken', to: token, fn: 'approve', args: [vault, fee], from, gasPrice,
        description: `Allow the deposit vault to take the ${tokenText(fee, unit)} court fee (exact amount).`,
      }),
    );
  }
  txs.push(
    await buildTx(env.ctx, {
      chain: 'hedera', contract: 'RecourseClaims', to: claims, fn: 'fileClaim',
      args: [orderNonce, platform, { topicNum: refs.topicNum, seq: refs.seq, hashes: refs.hashes }, basket, netLoss], from, gasPrice,
      description: `File the claim for order ${orderId.slice(0, 10)}...: escrows the court fee${reserves ? " and reserves the platform's deposit" : ''}.`,
      simulate: !approveNeeded, budget: FILE_CLAIM_BUDGET, revertCtx: { balance, required: fee },
    }),
  );
  const finding = await expectedFinding(env, orderId, picked.messages).catch(() => null);
  const notes: string[] = [];
  if (approveNeeded) {
    notes.push(`Send fileClaim only after approve has mined: it cannot be simulated before then, so its gas limit is a fixed ${FILE_CLAIM_BUDGET} budget. Building again once approve has mined simulates it and gives an estimate instead.`);
  }
  if (!picked.messages[KIND_PACKED]) notes.push('The topic holds no packed record from the shop: the fault rule answers against the shop from its packed step on.');
  if (finding) notes.push(`On these records the fault rule points at the ${finding.side} (${finding.reasonKey}); the pre-check service records the finding.`);
  const missing = picked.messages.map((m, k) => (m ? null : RECORD_KEYS[k])).filter((k): k is (typeof RECORD_KEYS)[number] => k !== null);
  if (missing.length > 0) notes.push(`No record from the order's own writers for: ${missing.join(', ')}.`);
  return answer(env.ctx, {
    action: 'fileClaim', chain: 'hedera', from, claimId, transactions: txs,
    summary: `File a claim for ${tokenText(netLoss, unit)} against the platform; the ${tokenText(fee, unit)} court fee is escrowed from your account.`,
    amounts: [
      amountOf('basket', basket, unit, 'info', null),
      amountOf('netLoss', netLoss, unit, 'info', null),
      amountOf('handling', handling, unit, 'info', null),
      amountOf('courtFee', fee, unit, 'escrow', from),
      // A vault from before reservations holds nothing back at filing: the most is then shown, not moved.
      reserves ? amountOf('maxPayout', maxPayout, unit, 'reserve', platform) : amountOf('maxPayout', maxPayout, unit, 'info', null),
    ],
    changes: [
      ...(approveNeeded ? [`Your allowance to the deposit vault is set to ${tokenText(fee, unit)}.`] : []),
      'The claim is filed (status filed) and the court fee moves into its escrow.',
      reserves
        ? `Up to ${tokenText(maxPayout, unit)} of the platform's deposit is reserved for this claim.`
        : "Nothing of the platform's deposit is reserved for this claim: this vault does not reserve, so a payout comes from whatever the deposit holds when the claim settles.",
      'The pre-check service then records a finding on its own.',
    ],
    statusAfter: 'filed',
    notes,
    builtAt: head.timestamp, notAfter: null, readBack: `/v1/claims/${claimId}`,
    input: {
      orderId, orderNonce, platform, shop: from, claimId,
      refs: { topicNum: refs.topicNum, seq: refs.seq, hashes: refs.hashes },
      basketUsdc: basket, netLossUsdc: netLoss, courtFeeUsdc: fee, handlingUsdc: handling, maxPayoutUsdc: maxPayout,
      approveNeeded, orderSource: shopOrder ? 'shop_service' : 'request', expectedFinding: finding,
    },
  });
}
