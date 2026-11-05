// After checkout: the shop's packed record, the buyer's arrived report and complaint, and what the
// shop would file. Simulated world (see world.ts); filing on the real contracts is in the anvil tests.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { RecordKind, decodeRecordMsg, recordHash, type Attrs } from '@recourse/shared';
import { Journal, RecordsClient, TopicReader, fetchDocument, type RecordsJournalRow } from '@recourse/records';
import { claimInputFor } from '../../shop/src/claim-input.js';
import { packOrder } from '../../shop/src/pack.js';
import type { ShopJournalRow } from '../../shop/src/orders.js';
import { TEST_SHOP_ACCOUNT } from '../../shop/test/helpers.js';
import { reportSigner } from '../src/approval.js';
import { arrivedBody } from '../src/docs.js';
import { AGENT, ASKED_CAP, PARTIES, TOPIC, docAt, world, type World } from './world.js';

let w: World | null = null;
afterEach(async () => {
  await w?.close();
  w = null;
});

const ARRIVED: Attrs = { brand: 'Northwind', size: 'One size', colour: 'Blue', quantity: '1', merchant: 'Test Shop' };

function shopRecords(x: World) {
  const journal = Journal.open<RecordsJournalRow>(join(mkdtempSync(join(tmpdir(), 'shop-records-')), 'records.jsonl'));
  const mirror = x.ledger.mirror();
  return new RecordsClient({
    role: 'shop',
    topicId: TOPIC,
    submitter: x.ledger.submitter(TEST_SHOP_ACCOUNT),
    pin: (bytes) => x.pin(bytes),
    reader: new TopicReader(mirror, TOPIC),
    mirror,
    journal,
    now: () => x.ledger.clock,
  });
}

async function paidOrder(x: World) {
  const { buyer } = x.open();
  const orderId = buyer.draft({ sku: 'cap-red', quantity: 1, asked: ASKED_CAP });
  expect((await buyer.run(orderId)).state).toBe('done');
  return { buyer, orderId };
}

function kindsOf(x: World, orderId: string) {
  return x.ledger
    .messages(TOPIC)
    .map((m) => ({ payer: m.payer, d: decodeRecordMsg(m.bytes) }))
    .filter((m) => m.d.ok && m.d.value.orderId === orderId)
    .map((m) => ({ payer: m.payer, kind: (m.d as { ok: true; value: { kind: number } }).value.kind }));
}

describe('packed record', () => {
  test('is written once from the shop account with the paid item and price', async () => {
    w = await world();
    const { orderId } = await paidOrder(w);
    const records = shopRecords(w);
    const first = await packOrder({ records, journal: w.shop.journal, orderId, merchant: 'Test Shop' });
    expect(first.existing).toBe(false);
    expect(await packOrder({ records, journal: w.shop.journal, orderId, merchant: 'Test Shop' })).toMatchObject({ seq: first.seq, existing: true });
    const packed = kindsOf(w, orderId).filter((m) => m.kind === RecordKind.Packed);
    expect(packed).toEqual([{ payer: TEST_SHOP_ACCOUNT, kind: RecordKind.Packed }]);
    expect(await docAt(w, first.cid)).toMatchObject({
      kind: 'packed',
      orderId,
      attrs: { brand: 'Northwind', size: 'One size', colour: 'Red', quantity: '1', merchant: 'Test Shop', price: '1 USDC' },
    });
  });

  test('is refused for an order the shop has no payment for', async () => {
    w = await world();
    await expect(
      packOrder({ records: shopRecords(w), journal: w.shop.journal, orderId: `0x${'ab'.repeat(32)}`, merchant: 'Test Shop' }),
    ).rejects.toThrow(/no paid order/);
  });
});

describe('arrived report and complaint', () => {
  test('commits one buyer-signed arrived record and the shop takes the complaint', async () => {
    w = await world();
    const { buyer, orderId } = await paidOrder(w);
    const report = await buyer.report(orderId, { attrs: ARRIVED, buyerAccount: w.buyerAccount });
    expect(report).toMatchObject({ orderId, shopAccepted: true });
    const doc = (await docAt(w, report.cid)) as Record<string, string> & { attrs: Attrs };
    expect(doc).toMatchObject({ kind: 'arrived', orderId, attrs: ARRIVED, buyerSigner: w.buyerAccount.address });
    const bodyHash = recordHash(arrivedBody({ orderId, attrs: doc.attrs, reportedAt: Number(doc.reportedAt) }));
    expect(await reportSigner(orderId, bodyHash, doc.buyerSignature as `0x${string}`)).toBe(w.buyerAccount.address);

    const view = (await (await fetch(`${w.shop.url}/orders/${orderId}`)).json()) as { order: { complaint: unknown } };
    expect(view.order.complaint).toEqual({ seq: String(report.seq), hash: report.hash, cid: report.cid });

    // Again, from a fresh process on the same journals: nothing new is written.
    const again = await w.open().buyer.report(orderId, { attrs: { ...ARRIVED, colour: 'Green' }, buyerAccount: w.buyerAccount });
    expect(again).toMatchObject({ seq: report.seq, cid: report.cid, shopAccepted: true });
    expect(kindsOf(w, orderId).filter((m) => m.kind === RecordKind.Arrived)).toEqual([{ payer: AGENT, kind: RecordKind.Arrived }]);
  });

  test('needs a paid, recorded order', async () => {
    w = await world();
    const { buyer } = w.open();
    const orderId = buyer.draft({ sku: 'cap-red', quantity: 1, asked: ASKED_CAP });
    await expect(buyer.report(orderId, { attrs: ARRIVED, buyerAccount: w.buyerAccount })).rejects.toThrow(/not paid/);
  });
});

describe('claim input', () => {
  test('takes the nonce, platform and basket from the shop journal and all six refs from the topic', async () => {
    w = await world();
    const { buyer, orderId } = await paidOrder(w);
    await packOrder({ records: shopRecords(w), journal: w.shop.journal, orderId, merchant: 'Test Shop' });
    await buyer.report(orderId, { attrs: ARRIVED, buyerAccount: w.buyerAccount });
    const rows = w.shop.journal.read().rows;
    const reader = new TopicReader(w.ledger.mirror(), TOPIC);
    const fetchDoc = (cid: string, hash: `0x${string}`) => fetchDocument(cid, hash, w!.ipfs.options());
    const input = await claimInputFor({ rows, reader, parties: PARTIES, orderId, fetchDoc });
    const paid = rows.find((r): r is Extract<ShopJournalRow, { type: 'order_paid' }> => r.type === 'order_paid' && r.orderId === orderId)!;
    expect(input).toMatchObject({ orderId, orderNonce: paid.orderNonce, platform: paid.platform, basketUsdc: 1_000_000n, netLossUsdc: 1_000_000n, settlement: paid.txId });
    expect(input.refs.topicNum).toBe(7000001n);
    expect(input.refs.seq.every((s) => s > 0n)).toBe(true);
    expect((await claimInputFor({ rows, reader, parties: PARTIES, orderId, fetchDoc, netLossUsdc: 5n })).netLossUsdc).toBe(5n);

    // A shop journal whose settlement differs from the ordered record's is refused.
    const altered = rows.map((r) => (r.type === 'order_paid' && r.orderId === orderId ? { ...r, txId: 'fake-settlement:other' } : r));
    await expect(claimInputFor({ rows: altered, reader, parties: PARTIES, orderId, fetchDoc })).rejects.toMatchObject({ code: 'ordered_tx_mismatch' });
    await expect(claimInputFor({ rows, reader, parties: PARTIES, orderId: `0x${'cd'.repeat(32)}`, fetchDoc })).rejects.toMatchObject({ code: 'not_paid' });
  });
});
