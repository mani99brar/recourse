// The agent's record documents, in the shared canonical form (strings, sorted keys, no numbers).
// Every document carries the core fields the fault rule reads; the rest is context for people and
// for re-rendering the approval text. Buyer details never appear in clear: each is a salted hash,
// and the salts stay in the agent's journal.

import type { Hex } from 'viem';
import { canonicalBytes, saltedField, type Attrs, type CanonicalValue } from '@recourse/shared';
import type { Rendered, RenderInput } from '@recourse/renderer';

type Obj = Record<string, CanonicalValue>;

function attrsValue(attrs: Attrs): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(attrs)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Salted hashes of the buyer's details, keyed like the input. */
export function saltedBuyer(details: Record<string, string>, salts: Record<string, Hex>): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(details)) {
    const salt = salts[k];
    if (!salt) throw new Error(`no salt for buyer field ${k}`);
    out[k] = saltedField(v, salt);
  }
  return out;
}

export function askedDoc(input: { orderId: Hex; asked: Attrs; sku: string; buyer: Obj }): Uint8Array {
  return canonicalBytes({
    v: '1',
    kind: 'asked',
    orderId: input.orderId,
    attrs: attrsValue(input.asked),
    request: { sku: input.sku },
    buyer: input.buyer,
  });
}

/** The shown record carries everything needed to render the same text again from I and S. */
export function shownDoc(renderInput: RenderInput, rendered: Rendered): Uint8Array {
  return canonicalBytes({
    v: '1',
    kind: 'shown',
    orderId: renderInput.orderId,
    attrs: attrsValue(rendered.shownAttrs),
    changes: [...rendered.changes],
    offer: attrsValue(renderInput.offer as Attrs),
    terms: { amount: renderInput.amount, asset: renderInput.asset, payTo: renderInput.payTo, network: renderInput.network },
    textHash: rendered.textHash,
    rendererVersion: rendered.rendererVersion,
  });
}

export function approvalDoc(input: {
  orderId: Hex;
  decision: 'approved' | 'not_approved';
  basis: 'mandate' | 'buyer';
  textHash: Hex;
  amount: string;
  asset: string;
  payTo: string;
  expiresAt: number;
  signer: string;
  signature: Hex;
  mandateCid?: string;
}): Uint8Array {
  const doc: Obj = {
    v: '1',
    kind: 'approval',
    orderId: input.orderId,
    approval: input.decision,
    approvalBasis: input.basis,
    textHash: input.textHash,
    amount: input.amount,
    asset: input.asset,
    payTo: input.payTo,
    expiresAt: String(input.expiresAt),
    signer: input.signer,
    signature: input.signature,
  };
  if (input.mandateCid) doc.mandateCid = input.mandateCid;
  return canonicalBytes(doc);
}

export function orderedDoc(input: { orderId: Hex; attrs: Attrs; x402TxId: string; amount: string; asset: string; payTo: string }): Uint8Array {
  return canonicalBytes({
    v: '1',
    kind: 'ordered',
    orderId: input.orderId,
    attrs: attrsValue(input.attrs),
    x402TxId: input.x402TxId,
    amount: input.amount,
    asset: input.asset,
    payTo: input.payTo,
  });
}

export function arrivedDoc(input: { orderId: Hex; attrs: Attrs; buyerSigner: string; buyerSignature: Hex; reportedAt: number }): Uint8Array {
  return canonicalBytes({
    v: '1',
    kind: 'arrived',
    orderId: input.orderId,
    attrs: attrsValue(input.attrs),
    buyerSigner: input.buyerSigner,
    buyerSignature: input.buyerSignature,
    reportedAt: String(input.reportedAt),
  });
}

/** The agent's standing mandate, pinned once; mandate approvals point at it. */
export function mandateDoc(input: { platform: string; agentSigner: string; spendLimit: bigint; maxOrder: bigint; dailyCap: bigint }): Uint8Array {
  return canonicalBytes({
    v: '1',
    kind: 'mandate',
    platform: input.platform,
    agentSigner: input.agentSigner,
    spendLimitUsdc: input.spendLimit.toString(),
    maxOrderUsdc: input.maxOrder.toString(),
    dailyCapUsdc: input.dailyCap.toString(),
  });
}
