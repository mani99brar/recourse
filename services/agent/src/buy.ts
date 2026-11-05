// The agent's buy flow, one journal row per step:
//
//   draft -> probe the 402 -> render the shown text -> approve -> commit asked, shown, approval
//         -> pay -> commit ordered
//
// The order nonce is drawn and journaled before any network call, so a restart reuses it. Every
// step reads the journal first and resumes where the last run stopped.
//
// Never pays twice for one order: the Hedera transaction id is journaled after signing and before
// sending. On any doubt (lost reply, restart, error) the shop's order view and the mirror node are
// asked about that exact transaction; a new payment is made only once the earlier one can no longer
// reach consensus. Only one payment is in flight at a time.
//
// Terms that change after the records were written end the order (`abandoned`); a new order with a
// new nonce is the way forward, because the shown record of this one is already on the topic.

import type { Address, Hex, LocalAccount } from 'viem';
import { bytesToHex } from 'viem';
import type { ClientHederaSigner } from '@x402/hedera';
import { RecordKind, newOrderNonce, orderIdOf, type Attrs, type RecordKind as Kind } from '@recourse/shared';
import { render, type RenderInput } from '@recourse/renderer';
import { validStartSeconds, type Journal, type Logger, type MirrorClient, type Pinned, type RecordsClient } from '@recourse/records';
import { signApproval } from './approval.js';
import { approvalDoc, askedDoc, mandateDoc, orderedDoc, saltedBuyer, shownDoc } from './docs.js';
import { decideLimit, utcDay, type Limits } from './limits.js';
import { NETWORK, PaymentRefused, chooseRequirement, payExactly, probe402, type FetchLike, type Terms } from './x402-pay.js';

export const PLATFORM_HEADER = 'x-recourse-platform';
export const NONCE_HEADER = 'x-recourse-order-nonce';

/** A signed payment that has not reached consensus by validStart + this is taken as dead. */
const PAYMENT_DEAD_AFTER_S = 240;

export interface ShopTarget {
  /** Base of the paid routes, ending in `/x402/`. */
  x402Base: string;
  /** Base of the shop's free routes (catalogue, orders). */
  apiBase: string;
  payTo: string;
  /** The shop's EVM address, the order id's shop. */
  shopAddress: Address;
  source: string;
}

type At = { at: string; orderId: Hex };

export type AgentRow =
  | { type: 'mandate'; at: string; cid: string; hash: Hex }
  | (At & {
      type: 'draft';
      orderNonce: Hex;
      platform: Address;
      shop: Address;
      sku: string;
      quantity: number;
      asked: Attrs;
      /** Salted buyer fields as written in the asked record; the salts sit beside them. */
      buyer: Record<string, Hex>;
      salts: Record<string, Hex>;
      day: string;
    })
  | (At & { type: 'probed'; url: string; terms: Terms; offer: Omit<Attrs, 'price'> })
  | (At & { type: 'rendered'; renderInput: RenderInput; textHash: Hex; changes: string[]; rendererVersion: string })
  | (At & { type: 'refused'; reason: string })
  | (At & { type: 'awaiting_approval'; approvalId: string; expiresAt: number })
  | (At & { type: 'approved'; basis: 'mandate' | 'buyer'; decision: 'approved' | 'not_approved'; expiresAt: number; signer: string; signature: Hex })
  | (At & { type: 'committed'; kind: Kind; seq: number; hash: Hex; cid: string; simulated?: true })
  | (At & { type: 'pay_attempt'; startedAt: number })
  | (At & { type: 'pay_signed'; txId: string; feePayer: string })
  | (At & { type: 'pay_dead'; txId: string; reason: string })
  | (At & { type: 'paid'; txId: string; source: 'settlement' | 'shop' | 'mirror'; offer: Omit<Attrs, 'price'> | null })
  | (At & { type: 'pay_failed'; status: number; error: string })
  | (At & { type: 'abandoned'; reason: string })
  | (At & { type: 'done' });

export type OrderOutcome =
  | { state: 'done'; orderId: Hex; txId: string }
  | { state: 'awaiting_approval'; orderId: Hex; approvalId: string; expiresAt: number }
  | { state: 'refused' | 'abandoned' | 'declined' | 'expired'; orderId: Hex; reason: string }
  | { state: 'pay_failed'; orderId: Hex; reason: string };

export interface OrderDraft {
  sku: string;
  quantity: number;
  asked: Attrs;
  /** Buyer details (name, address); only salted hashes leave the agent. */
  buyer?: Record<string, string>;
}

export interface BuyerDeps {
  platform: Address;
  shop: ShopTarget;
  records: RecordsClient;
  /** Pins a plain document (the mandate) without an HCS message. */
  pin: (bytes: Uint8Array) => Promise<Pinned>;
  payer: ClientHederaSigner;
  /** The agent key as an EVM account; signs mandate approvals. */
  agentAccount: LocalAccount;
  mirror: MirrorClient;
  journal: Journal<AgentRow>;
  limits: Limits;
  asset: string;
  log?: Logger;
  /** Unix seconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: FetchLike;
  randomSalt?: () => Hex;
  pollMs?: number;
}

const iso = () => new Date().toISOString();

function salt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

export class Buyer {
  private readonly rows: AgentRow[];
  private payLock: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly deps: BuyerDeps) {
    this.rows = [...deps.journal.rows()];
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetchImpl = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  private write(row: AgentRow): void {
    this.deps.journal.append(row);
    this.rows.push(row);
  }

  private rowsOf(orderId: Hex): Extract<AgentRow, { orderId: Hex }>[] {
    return this.rows.filter((r): r is Extract<AgentRow, { orderId: Hex }> => 'orderId' in r && r.orderId === orderId);
  }

  private last<T extends AgentRow['type']>(orderId: Hex, type: T): Extract<AgentRow, { type: T }> | undefined {
    return this.rowsOf(orderId).filter((r) => r.type === type).at(-1) as Extract<AgentRow, { type: T }> | undefined;
  }

  /** Every order this journal knows, oldest first. */
  orders(): Hex[] {
    return this.rows.filter((r): r is Extract<AgentRow, { type: 'draft' }> => r.type === 'draft').map((r) => r.orderId);
  }

  /** Draws the nonce and journals the draft; nothing else happens until `run`. */
  draft(input: OrderDraft): Hex {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new Error('quantity must be a positive whole number');
    const orderNonce = newOrderNonce();
    const orderId = orderIdOf(this.deps.platform, this.deps.shop.shopAddress, orderNonce);
    const salts: Record<string, Hex> = {};
    for (const k of Object.keys(input.buyer ?? {})) salts[k] = (this.deps.randomSalt ?? salt)();
    const buyer = saltedBuyer(input.buyer ?? {}, salts) as Record<string, Hex>;
    this.write({
      type: 'draft',
      at: iso(),
      orderId,
      orderNonce,
      platform: this.deps.platform,
      shop: this.deps.shop.shopAddress,
      sku: input.sku,
      quantity: input.quantity,
      asked: input.asked,
      buyer,
      salts,
      day: utcDay(this.now()),
    });
    return orderId;
  }

  private headers(draft: Extract<AgentRow, { type: 'draft' }>): Record<string, string> {
    return { 'content-type': 'application/json', [PLATFORM_HEADER]: draft.platform, [NONCE_HEADER]: draft.orderNonce };
  }

  private orderUrl(draft: Extract<AgentRow, { type: 'draft' }>): string {
    return `${this.deps.shop.x402Base.replace(/\/+$/, '')}/orders/${draft.sku}/${draft.quantity}`;
  }

  /** Micro-USDC committed today by orders that are paid or may still be paid, other than `except`. */
  private spentToday(day: string, except: Hex): bigint {
    let sum = 0n;
    for (const id of this.orders()) {
      if (id === except) continue;
      const d = this.last(id, 'draft');
      if (d?.day !== day) continue;
      const end = this.rowsOf(id).find((r) => r.type === 'refused' || r.type === 'abandoned' || (r.type === 'approved' && r.decision !== 'approved'));
      if (end) continue;
      const probed = this.last(id, 'probed');
      if (probed && this.last(id, 'approved')) sum += BigInt(probed.terms.amount);
    }
    return sum;
  }

  private async mandateCid(): Promise<string> {
    const existing = this.rows.find((r): r is Extract<AgentRow, { type: 'mandate' }> => r.type === 'mandate');
    if (existing) return existing.cid;
    const pinned = await this.deps.pin(
      mandateDoc({
        platform: this.deps.platform,
        agentSigner: this.deps.agentAccount.address,
        spendLimit: this.deps.limits.spendLimit,
        maxOrder: this.deps.limits.maxOrder,
        dailyCap: this.deps.limits.dailyCap,
      }),
    );
    this.write({ type: 'mandate', at: iso(), cid: pinned.cid, hash: pinned.hash });
    return pinned.cid;
  }

  private async commit(orderId: Hex, kind: Kind, bytes: Uint8Array): Promise<void> {
    if (this.rowsOf(orderId).some((r) => r.type === 'committed' && r.kind === kind)) return;
    const c = await this.deps.records.commitRecord(kind, orderId, bytes);
    this.write({ type: 'committed', at: iso(), orderId, kind, seq: c.seq, hash: c.hash, cid: c.cid, ...(c.simulated ? { simulated: true as const } : {}) });
  }

  /** Drives the order as far as it can go now. Safe to call again at any point, after any crash. */
  async run(orderId: Hex): Promise<OrderOutcome> {
    const draft = this.last(orderId, 'draft');
    if (!draft) throw new Error(`no draft for ${orderId}`);
    const ended = this.endState(orderId);
    if (ended) return ended;

    // Probe: price, asset, network and payee come from the 402 only.
    let probed = this.last(orderId, 'probed');
    if (!probed) {
      const url = this.orderUrl(draft);
      const probe = await probe402(url, { method: 'POST', headers: this.headers(draft), body: '{}' }, this.fetchImpl);
      const requirement = chooseRequirement(probe.paymentRequired, { asset: this.deps.asset, expectedPayTo: this.deps.shop.payTo });
      const offer = await this.offerOf(draft);
      probed = { type: 'probed', at: iso(), orderId, url, terms: { network: requirement.network, asset: requirement.asset, amount: requirement.amount, payTo: requirement.payTo }, offer };
      this.write(probed);
    }

    let rendered = this.last(orderId, 'rendered');
    if (!rendered) {
      const renderInput: RenderInput = {
        orderId,
        asked: draft.asked,
        offer: probed.offer,
        amount: probed.terms.amount,
        asset: probed.terms.asset,
        payTo: probed.terms.payTo,
        network: probed.terms.network,
      };
      const r = render(renderInput);
      rendered = { type: 'rendered', at: iso(), orderId, renderInput, textHash: r.textHash, changes: r.changes, rendererVersion: r.rendererVersion };
      this.write(rendered);
    }

    let approved = this.last(orderId, 'approved');
    if (!approved) {
      const amount = BigInt(probed.terms.amount);
      const decision = decideLimit(amount, this.spentToday(draft.day, orderId), this.deps.limits);
      if (decision.kind === 'refused') {
        this.write({ type: 'refused', at: iso(), orderId, reason: decision.reason });
        return { state: 'refused', orderId, reason: decision.reason };
      }
      if (decision.kind === 'buyer') {
        const waiting = this.last(orderId, 'awaiting_approval');
        if (waiting && this.now() > waiting.expiresAt) {
          this.write({ type: 'abandoned', at: iso(), orderId, reason: 'approval_expired' });
          return { state: 'expired', orderId, reason: 'approval_expired' };
        }
        if (waiting) return { state: 'awaiting_approval', orderId, approvalId: waiting.approvalId, expiresAt: waiting.expiresAt };
        const expiresAt = this.now() + this.deps.limits.approvalTtlSec;
        const approvalId = orderId.slice(2, 18);
        this.write({ type: 'awaiting_approval', at: iso(), orderId, approvalId, expiresAt });
        return { state: 'awaiting_approval', orderId, approvalId, expiresAt };
      }
      const expiresAt = this.now() + this.deps.limits.approvalTtlSec;
      const signature = await signApproval(this.deps.agentAccount, {
        orderId,
        textHash: rendered.textHash,
        amount: probed.terms.amount,
        payTo: probed.terms.payTo,
        decision: 'approved',
        expiresAt,
      });
      approved = { type: 'approved', at: iso(), orderId, basis: 'mandate', decision: 'approved', expiresAt, signer: this.deps.agentAccount.address, signature };
      this.write(approved);
    }

    // The three records written before paying.
    await this.commit(orderId, RecordKind.Asked, askedDoc({ orderId, asked: draft.asked, sku: draft.sku, buyer: draft.buyer }));
    await this.commit(orderId, RecordKind.Shown, shownDoc(rendered.renderInput, render(rendered.renderInput)));
    await this.commit(
      orderId,
      RecordKind.Approval,
      approvalDoc({
        orderId,
        decision: approved.decision,
        basis: approved.basis,
        textHash: rendered.textHash,
        amount: probed.terms.amount,
        asset: probed.terms.asset,
        payTo: probed.terms.payTo,
        expiresAt: approved.expiresAt,
        signer: approved.signer,
        signature: approved.signature,
        ...(approved.basis === 'mandate' ? { mandateCid: await this.mandateCid() } : {}),
      }),
    );
    if (approved.decision !== 'approved') {
      this.write({ type: 'abandoned', at: iso(), orderId, reason: 'declined' });
      return { state: 'declined', orderId, reason: 'declined' };
    }

    let paid = this.last(orderId, 'paid');
    if (!paid) {
      const result = await this.withPayLock(() => this.pay(orderId, draft, probed!));
      if (result.state !== 'paid') return result.outcome;
      paid = result.row;
    }

    if (!paid.txId) throw new Error('paid without a transaction id');
    await this.commit(
      orderId,
      RecordKind.Ordered,
      orderedDoc({
        orderId,
        attrs: { ...(paid.offer ?? probed.offer), price: render(rendered.renderInput).shownAttrs.price! },
        x402TxId: paid.txId,
        amount: probed.terms.amount,
        asset: probed.terms.asset,
        payTo: probed.terms.payTo,
      }),
    );
    this.write({ type: 'done', at: iso(), orderId });
    return { state: 'done', orderId, txId: paid.txId };
  }

  /** Records the buyer's signed decision for an order waiting on one. */
  recordBuyerDecision(orderId: Hex, decision: 'approved' | 'not_approved', signer: string, signature: Hex, expiresAt: number): void {
    const waiting = this.last(orderId, 'awaiting_approval');
    if (!waiting) throw new Error('no approval is pending for this order');
    if (this.last(orderId, 'approved')) throw new Error('this order already has a decision');
    this.write({ type: 'approved', at: iso(), orderId, basis: 'buyer', decision, expiresAt, signer, signature });
  }

  /** The approval waiting for a buyer, with what the buyer must sign. */
  pendingApproval(orderId: Hex) {
    const waiting = this.last(orderId, 'awaiting_approval');
    const rendered = this.last(orderId, 'rendered');
    const probed = this.last(orderId, 'probed');
    if (!waiting || !rendered || !probed || this.last(orderId, 'approved')) return null;
    return { approvalId: waiting.approvalId, expiresAt: waiting.expiresAt, rendered, terms: probed.terms };
  }

  findByApprovalId(approvalId: string): Hex | null {
    const row = this.rows.find((r) => r.type === 'awaiting_approval' && r.approvalId === approvalId);
    return row && 'orderId' in row ? row.orderId : null;
  }

  private endState(orderId: Hex): OrderOutcome | null {
    for (const r of this.rowsOf(orderId)) {
      if (r.type === 'done') return { state: 'done', orderId, txId: this.last(orderId, 'paid')!.txId };
      if (r.type === 'refused') return { state: 'refused', orderId, reason: r.reason };
      if (r.type === 'abandoned') {
        const state = r.reason === 'declined' ? 'declined' : r.reason === 'approval_expired' ? 'expired' : 'abandoned';
        return { state, orderId, reason: r.reason };
      }
    }
    return null;
  }

  private async offerOf(draft: Extract<AgentRow, { type: 'draft' }>): Promise<Omit<Attrs, 'price'>> {
    const res = await this.fetchImpl(`${this.deps.shop.apiBase}/catalog`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`catalog: ${res.status}`);
    const catalog = (await res.json()) as { items?: { sku: string; offer: Record<string, string> }[] };
    const item = catalog.items?.find((i) => i.sku === draft.sku);
    if (!item) throw new Error(`catalog: no item ${draft.sku}`);
    const offer: Omit<Attrs, 'price'> = {};
    for (const k of ['brand', 'size', 'colour', 'merchant'] as const) {
      const v = item.offer[k];
      if (typeof v === 'string') offer[k] = v;
    }
    offer.quantity = String(draft.quantity);
    return offer;
  }

  private async withPayLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.payLock.then(fn, fn);
    this.payLock = run.catch(() => undefined);
    return run;
  }

  private async shopOrder(orderId: Hex): Promise<{ txId: string } | null> {
    try {
      const res = await this.fetchImpl(`${this.deps.shop.apiBase}/orders/${orderId}`, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) return null;
      const body = (await res.json()) as { order?: { payment?: { txId?: string } } };
      const txId = body.order?.payment?.txId;
      return txId ? { txId } : null;
    } catch {
      return null;
    }
  }

  /**
   * What became of a signed payment: paid (the shop has the order, or the mirror node shows the
   * transfer), dead (failed on chain, or past its validity window with no trace), or still open.
   */
  private async resolveSigned(orderId: Hex, signed: Extract<AgentRow, { type: 'pay_signed' }>): Promise<{ state: 'paid'; txId: string; source: 'shop' | 'mirror' } | { state: 'dead'; reason: string } | { state: 'open' }> {
    const fromShop = await this.shopOrder(orderId);
    if (fromShop) return { state: 'paid', txId: fromShop.txId, source: 'shop' };
    const tx = await this.deps.mirror.transaction(signed.txId).catch(() => undefined);
    if (tx && tx.result === 'SUCCESS') return { state: 'paid', txId: signed.txId, source: 'mirror' };
    if (tx) return { state: 'dead', reason: `transaction ${tx.result}` };
    if (tx === null && this.now() > validStartSeconds(signed.txId) + PAYMENT_DEAD_AFTER_S) return { state: 'dead', reason: 'expired unseen' };
    return { state: 'open' };
  }

  private async pay(
    orderId: Hex,
    draft: Extract<AgentRow, { type: 'draft' }>,
    probed: Extract<AgentRow, { type: 'probed' }>,
  ): Promise<{ state: 'paid'; row: Extract<AgentRow, { type: 'paid' }> } | { state: 'stopped'; outcome: OrderOutcome }> {
    const markPaid = (txId: string, source: 'settlement' | 'shop' | 'mirror', offer: Omit<Attrs, 'price'> | null) => {
      const row = { type: 'paid' as const, at: iso(), orderId, txId, source, offer };
      this.write(row);
      this.deps.log?.info('order_paid', { orderId, txId, source });
      return { state: 'paid' as const, row };
    };

    for (let round = 0; ; round++) {
      // Settle every signed payment of this order that is still open before signing another.
      const dead = new Set(this.rowsOf(orderId).filter((r) => r.type === 'pay_dead').map((r) => (r as { txId: string }).txId));
      const open = this.rowsOf(orderId).filter((r): r is Extract<AgentRow, { type: 'pay_signed' }> => r.type === 'pay_signed' && !dead.has(r.txId));
      let waiting = false;
      for (const signed of open) {
        const r = await this.resolveSigned(orderId, signed);
        if (r.state === 'paid') return markPaid(r.txId, r.source, null);
        if (r.state === 'dead') this.write({ type: 'pay_dead', at: iso(), orderId, txId: signed.txId, reason: r.reason });
        else waiting = true;
      }
      if (waiting) {
        await this.sleep(this.deps.pollMs ?? 5000);
        continue;
      }
      // The shop may know the order from a payment journaled under another attempt.
      const known = await this.shopOrder(orderId);
      if (known) return markPaid(known.txId, 'shop', null);
      if (round > 20) {
        this.write({ type: 'pay_failed', at: iso(), orderId, status: 0, error: 'too many attempts' });
        return { state: 'stopped', outcome: { state: 'pay_failed', orderId, reason: 'too many attempts' } };
      }

      const records = this.rowsOf(orderId).filter((r): r is Extract<AgentRow, { type: 'committed' }> => r.type === 'committed');
      const ref = (kind: Kind) => {
        const c = records.find((r) => r.kind === kind);
        if (!c) throw new Error(`record ${kind} not committed`);
        return { seq: String(c.seq), hash: c.hash };
      };
      const body = JSON.stringify({
        orderId,
        refs: { asked: ref(RecordKind.Asked), shown: ref(RecordKind.Shown), approval: ref(RecordKind.Approval) },
      });
      // A new payment only while the approval holds.
      const approval = this.last(orderId, 'approved');
      if (!approval || this.now() > approval.expiresAt) {
        this.write({ type: 'abandoned', at: iso(), orderId, reason: 'approval_expired' });
        return { state: 'stopped', outcome: { state: 'expired', orderId, reason: 'approval_expired' } };
      }
      this.write({ type: 'pay_attempt', at: iso(), orderId, startedAt: this.now() });
      try {
        const res = await payExactly({
          url: probed.url,
          init: { method: 'POST', headers: this.headers(draft), body },
          approved: probed.terms,
          signer: this.deps.payer,
          onSigned: (s) => this.write({ type: 'pay_signed', at: iso(), orderId, txId: s.txId, feePayer: s.feePayer }),
          fetchImpl: this.fetchImpl,
        });
        if (res.status === 200) {
          const reply = res.body as { txId?: string; offer?: Omit<Attrs, 'price'> };
          const txId = res.settlement?.transaction || reply.txId || '';
          if (txId) return markPaid(txId, 'settlement', reply.offer ?? null);
          // A 200 with no transaction id: settle it through the signed payment on the next round.
          continue;
        }
        if (res.status === 409) {
          const reply = res.body as { error?: string; order?: { payment?: { txId?: string } } };
          const txId = reply.order?.payment?.txId;
          if (reply.error === 'order_exists' && txId) return markPaid(txId, 'shop', null);
          await this.sleep(this.deps.pollMs ?? 5000);
          continue;
        }
        if (!res.signed) {
          // Refused before anything was signed: the shop said no; nothing can be in flight.
          const error = JSON.stringify(res.body).slice(0, 200);
          this.write({ type: 'pay_failed', at: iso(), orderId, status: res.status, error });
          return { state: 'stopped', outcome: { state: 'pay_failed', orderId, reason: `shop answered ${res.status}: ${error}` } };
        }
        // Signed but not confirmed (settle failed, 5xx): the next round settles that payment.
        this.deps.log?.warn('payment_unconfirmed', { orderId, status: res.status });
      } catch (error) {
        if (error instanceof PaymentRefused && error.code === 'terms_changed') {
          this.write({ type: 'abandoned', at: iso(), orderId, reason: 'terms_changed' });
          return { state: 'stopped', outcome: { state: 'abandoned', orderId, reason: 'terms_changed' } };
        }
        if (error instanceof PaymentRefused) {
          this.write({ type: 'abandoned', at: iso(), orderId, reason: error.code });
          return { state: 'stopped', outcome: { state: 'abandoned', orderId, reason: error.code } };
        }
        this.deps.log?.warn('payment_error', { orderId, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        await this.sleep(this.deps.pollMs ?? 5000);
      }
    }
  }
}

export { NETWORK };
