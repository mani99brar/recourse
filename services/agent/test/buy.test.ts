import { afterEach, describe, expect, test } from 'vitest';
import { decodeRecordMsg, RecordKind } from '@recourse/shared';
import { render, type RenderInput } from '@recourse/renderer';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { memoryLogger, readJournal } from '@recourse/records';
import { approvalSigner, signApproval } from '../src/approval.js';
import { createApprovalsApi } from '../src/approvals-api.js';
import type { AgentRow } from '../src/buy.js';
import { AGENT, ASKED_CAP, TOPIC, docAt, world, type World } from './world.js';

let w: World | null = null;
afterEach(async () => {
  await w?.close();
  w = null;
});

function messages(x: World) {
  return x.ledger
    .messages(TOPIC)
    .map((m) => ({ payer: m.payer, d: decodeRecordMsg(m.bytes) }))
    .filter((m) => m.d.ok)
    .map((m) => ({ payer: m.payer, ...(m.d as { ok: true; value: { kind: number; orderId: string; cid: string; hash: string } }).value }));
}

describe('below the spend limit', () => {
  test('pays with no human and leaves asked, shown, approval and ordered on the topic', async () => {
    w = await world();
    const { buyer } = w.open();
    const orderId = buyer.draft({ sku: 'cap-red', quantity: 1, asked: ASKED_CAP, buyer: { name: 'Ada Example', address: '1 Sample Road' } });
    const outcome = await buyer.run(orderId);
    expect(outcome).toMatchObject({ state: 'done', orderId });
    expect(w.fake.settled).toHaveLength(1);
    expect(w.fake.settled[0]).toMatchObject({ amount: '1000000', payer: AGENT });

    const msgs = messages(w).filter((m) => m.orderId === orderId);
    expect(msgs.map((m) => m.kind)).toEqual([RecordKind.Asked, RecordKind.Shown, RecordKind.Approval, RecordKind.Ordered]);
    expect(msgs.every((m) => m.payer === AGENT)).toBe(true);

    const [asked, shown, approval, ordered] = await Promise.all(msgs.map((m) => docAt(w!, m.cid)));
    // Buyer details only as salted hashes.
    expect(JSON.stringify(asked)).not.toContain('Ada');
    expect((asked!.buyer as Record<string, string>).name).toMatch(/^0x[0-9a-f]{64}$/);
    // The shown record lets anyone render the same text again.
    const terms = shown!.terms as { amount: string; asset: string; payTo: string; network: string };
    const again = render({ orderId, asked: asked!.attrs as RenderInput['asked'], offer: shown!.offer as RenderInput['offer'], ...terms });
    expect(again.textHash).toBe(shown!.textHash);
    expect(shown!.changes).toEqual([]);
    // Mandate approval, signed by the agent key over the text hash, amount and payee.
    expect(approval).toMatchObject({ approval: 'approved', approvalBasis: 'mandate', amount: '1000000', textHash: shown!.textHash });
    expect(approval!.mandateCid).toBeTruthy();
    const signer = await approvalSigner(
      { orderId, textHash: shown!.textHash as `0x${string}`, amount: '1000000', payTo: terms.payTo, decision: 'approved', expiresAt: Number(approval!.expiresAt) },
      approval!.signature as `0x${string}`,
    );
    expect(signer).toBe(w.agentAccount.address);
    expect(ordered!.x402TxId).toBe(w.fake.settled[0]!.txId);
    expect(outcome.state === 'done' && outcome.txId).toBe(w.fake.settled[0]!.txId);

    // Running again changes nothing.
    expect(await buyer.run(orderId)).toEqual(outcome);
    expect(w.fake.settled).toHaveLength(1);
  });

  test('a changed offer fills the change slot and is still bought on the mandate when within the cap', async () => {
    w = await world();
    const { buyer } = w.open();
    const orderId = buyer.draft({ sku: 'tee-navy-l', quantity: 1, asked: { brand: 'Northwind', size: 'M', colour: 'Navy', price: '2.00' } });
    expect((await buyer.run(orderId)).state).toBe('done');
    const shown = messages(w).find((m) => m.orderId === orderId && m.kind === RecordKind.Shown)!;
    expect((await docAt(w, shown.cid)).changes).toEqual(['size']);
  });
});

describe('limits', () => {
  test('above the maximum, or past the daily cap, nothing is written and nothing is paid', async () => {
    w = await world({ limits: { maxOrder: 5_500_000n, dailyCap: 2_500_000n } });
    const { buyer } = w.open();
    const big = buyer.draft({ sku: 'hoodie-grey-m', quantity: 1, asked: { brand: 'Northwind' } });
    expect(await buyer.run(big)).toMatchObject({ state: 'refused', reason: 'above_max_order' });
    const first = buyer.draft({ sku: 'tee-navy-m', quantity: 1, asked: { brand: 'Northwind' } });
    expect((await buyer.run(first)).state).toBe('done');
    const second = buyer.draft({ sku: 'tee-navy-m', quantity: 1, asked: { brand: 'Northwind' } });
    expect(await buyer.run(second)).toMatchObject({ state: 'refused', reason: 'daily_cap' });
    expect(messages(w).filter((m) => m.orderId === big || m.orderId === second)).toHaveLength(0);
    expect(w.fake.settled).toHaveLength(1);
  });
});

describe('above the spend limit', () => {
  async function pending(x: World) {
    const { buyer } = x.open();
    const orderId = buyer.draft({ sku: 'hoodie-grey-m', quantity: 1, asked: { brand: 'Northwind', size: 'M', colour: 'Grey', price: '7.00' } });
    const outcome = await buyer.run(orderId);
    expect(outcome.state).toBe('awaiting_approval');
    expect(messages(x)).toHaveLength(0);
    expect(x.fake.settled).toHaveLength(0);
    return { buyer, orderId, request: buyer.pendingApproval(orderId)! };
  }

  test('waits for the buyer, then pays once the buyer signs', async () => {
    w = await world();
    const { buyer, orderId, request } = await pending(w);
    const message = { orderId, textHash: request.rendered.textHash, amount: request.terms.amount, payTo: request.terms.payTo, decision: 'approved' as const, expiresAt: request.expiresAt };
    buyer.recordBuyerDecision(orderId, 'approved', w.buyerAccount.address, await signApproval(w.buyerAccount, message), request.expiresAt);
    expect((await buyer.run(orderId)).state).toBe('done');
    const a = messages(w).find((m) => m.kind === RecordKind.Approval)!;
    expect(await docAt(w, a.cid)).toMatchObject({ approval: 'approved', approvalBasis: 'buyer', signer: w.buyerAccount.address });
    expect(w.fake.settled).toHaveLength(1);
  });

  test('the approvals API shows what the buyer signs, read from the journal', async () => {
    w = await world();
    const { orderId, request } = await pending(w);
    const api = createApprovalsApi({ rows: () => readJournal<AgentRow>(join(w!.dir, 'orders.jsonl')).rows, log: memoryLogger(), now: () => w!.ledger.clock });
    const server = await new Promise<Server>((resolve) => {
      const s = api.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/approvals/${request.approvalId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { orderId: string; textHash: string; text: string; expired: boolean; typedData: { message: Record<string, unknown> } };
      expect(body).toMatchObject({ orderId, textHash: request.rendered.textHash, expired: false });
      expect(render(request.rendered.renderInput).text).toBe(body.text);
      expect(body.typedData.message).toMatchObject({ orderId, textHash: request.rendered.textHash, amount: request.terms.amount, decision: 'approved' });
      expect((await fetch(`http://127.0.0.1:${port}/approvals/unknown`)).status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('a decline is recorded and nothing is paid', async () => {
    w = await world();
    const { buyer, orderId, request } = await pending(w);
    const message = { orderId, textHash: request.rendered.textHash, amount: request.terms.amount, payTo: request.terms.payTo, decision: 'not_approved' as const, expiresAt: request.expiresAt };
    buyer.recordBuyerDecision(orderId, 'not_approved', w.buyerAccount.address, await signApproval(w.buyerAccount, message), request.expiresAt);
    expect((await buyer.run(orderId)).state).toBe('declined');
    const kinds = messages(w).map((m) => m.kind);
    expect(kinds).toEqual([RecordKind.Asked, RecordKind.Shown, RecordKind.Approval]);
    expect(await docAt(w, messages(w)[2]!.cid)).toMatchObject({ approval: 'not_approved', approvalBasis: 'buyer' });
    expect(w.fake.settled).toHaveLength(0);
  });

  test('an approval that expires leaves no records and no order', async () => {
    w = await world();
    const { buyer, orderId } = await pending(w);
    w.ledger.clock += w.limits.approvalTtlSec + 1;
    expect((await buyer.run(orderId)).state).toBe('expired');
    expect(messages(w)).toHaveLength(0);
    expect(w.fake.settled).toHaveLength(0);
  });
});

describe('terms that change', () => {
  test('a different amount in the second 402 ends the order without paying', async () => {
    w = await world();
    let orderCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const res = await fetch(input, init);
      if (!url.includes('/x402/orders/')) return res;
      orderCalls += 1;
      const header = res.headers.get('payment-required');
      if (orderCalls < 2 || res.status !== 402 || !header) return res;
      const pr = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { accepts: { amount: string }[] };
      for (const a of pr.accepts) a.amount = String(BigInt(a.amount) + 1n);
      const headers = new Headers(res.headers);
      headers.set('payment-required', Buffer.from(JSON.stringify(pr)).toString('base64'));
      return new Response(await res.text(), { status: 402, headers });
    };
    const { buyer } = w.open({ fetchImpl });
    const orderId = buyer.draft({ sku: 'cap-red', quantity: 1, asked: ASKED_CAP });
    expect(await buyer.run(orderId)).toMatchObject({ state: 'abandoned', reason: 'terms_changed' });
    expect(w.fake.settled).toHaveLength(0);
    expect(messages(w).some((m) => m.kind === RecordKind.Ordered)).toBe(false);
  });
});

describe('paid in HBAR', () => {
  test('the limits compare the micro-USDC equivalent; the records keep the tinybar amount', async () => {
    w = await world({ priceAsset: 'hbar' });
    const { buyer } = w.open();
    // 1 HBAR: within the 5 USDC spend limit at 1 HBAR per USDC, though 100000000 tinybar is above every limit.
    expect((await buyer.preview({ sku: 'cap-red', quantity: 1, asked: ASKED_CAP })).decision).toEqual({ kind: 'mandate' });
    const orderId = buyer.draft({ sku: 'cap-red', quantity: 1, asked: ASKED_CAP });
    expect(await buyer.run(orderId)).toMatchObject({ state: 'done', orderId });
    expect(w.fake.settled).toHaveLength(1);
    expect(w.fake.settled[0]).toMatchObject({ amount: '100000000', asset: '0.0.0', payer: AGENT });

    const msgs = messages(w).filter((m) => m.orderId === orderId);
    const [, shown, approval, ordered] = await Promise.all(msgs.map((m) => docAt(w!, m.cid)));
    expect(shown).toMatchObject({ attrs: { price: '1.00 HBAR' }, changes: [], terms: { amount: '100000000', asset: '0.0.0' } });
    expect(approval).toMatchObject({ approval: 'approved', approvalBasis: 'mandate', amount: '100000000', asset: '0.0.0' });
    expect(ordered).toMatchObject({ amount: '100000000', asset: '0.0.0', attrs: { price: '1.00 HBAR' } });
    // The mandate states its limits in micro-USDC, unscaled.
    expect(await docAt(w, approval!.mandateCid as string)).toMatchObject({ spendLimitUsdc: '5000000', maxOrderUsdc: '25000000', dailyCapUsdc: '50000000' });
  });

  test('the maximum and the daily cap hold at the micro-USDC equivalent', async () => {
    w = await world({ priceAsset: 'hbar', limits: { maxOrder: 5_500_000n, dailyCap: 3_000_000n } });
    const { buyer } = w.open();
    const big = buyer.draft({ sku: 'hoodie-grey-m', quantity: 1, asked: { brand: 'Northwind' } });
    expect(await buyer.run(big)).toMatchObject({ state: 'refused', reason: 'above_max_order' });
    // Two 1.5 HBAR orders reach the 3 USDC cap exactly; the paid one counts as 1.5 USDC, not 150000000.
    const first = buyer.draft({ sku: 'tee-navy-m', quantity: 1, asked: { brand: 'Northwind' } });
    expect((await buyer.run(first)).state).toBe('done');
    const second = buyer.draft({ sku: 'tee-navy-m', quantity: 1, asked: { brand: 'Northwind' } });
    expect((await buyer.run(second)).state).toBe('done');
    const third = buyer.draft({ sku: 'cap-red', quantity: 1, asked: { brand: 'Northwind' } });
    expect(await buyer.run(third)).toMatchObject({ state: 'refused', reason: 'daily_cap' });
    expect(w.fake.settled.map((s) => [s.amount, s.asset])).toEqual([
      ['150000000', '0.0.0'],
      ['150000000', '0.0.0'],
    ]);
  });

  test('6 HBAR is above the 5 USDC spend limit and waits for the buyer', async () => {
    w = await world({ priceAsset: 'hbar' });
    const { buyer } = w.open();
    const orderId = buyer.draft({ sku: 'hoodie-grey-m', quantity: 1, asked: { brand: 'Northwind', price: '7.00' } });
    expect((await buyer.run(orderId)).state).toBe('awaiting_approval');
    expect(buyer.pendingApproval(orderId)!.terms).toMatchObject({ amount: '600000000', asset: '0.0.0' });
    expect(w.fake.settled).toHaveLength(0);
  });
});
