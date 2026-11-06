// TEST ONLY: one simulated world for the buy flow. A real shop app on a local port with a fake
// facilitator, an in-memory HCS topic and IPFS, and fresh keys. Every account and name is made up.
// `open()` builds the agent as a freshly started process would, on the same journals.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@hiero-ledger/sdk';
import { createClientHederaSigner } from '@x402/hedera';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Hex } from 'viem';
import { HBAR_ASSET_ID, priceAssetIdOf, type Parties, type PriceAsset } from '@recourse/shared';
import {
  Journal,
  MemoryIpfs,
  MemoryLedger,
  MirrorClient,
  RecordsClient,
  TopicReader,
  memoryLogger,
  mirrorTransactionId,
  pinDocument,
  type MemorySubmitterOptions,
  type RecordsJournalRow,
} from '@recourse/records';
import { fakeFacilitator, type FakeFacilitator } from '../../shop/test/fake-facilitator.js';
import { TEST_SHOP_ACCOUNT, TEST_SHOP_ADDRESS, startTestShop } from '../../shop/test/helpers.js';
import { Buyer, type AgentRow } from '../src/buy.js';
import { DEFAULT_LIMITS, type Limits } from '../src/limits.js';
import type { FetchLike } from '../src/x402-pay.js';

export const TOPIC = '0.0.7000001';
export const AGENT = '0.0.990300';
export const PLATFORM = getAddress('0x00000000000000000000000000000000000000a1');

export const PARTIES: Parties = [
  { role: 'platform', evmAddress: PLATFORM, hederaAccountId: '0.0.990001', hcsWriters: [AGENT], displayName: 'Demo Agent Co' },
  { role: 'shop', evmAddress: TEST_SHOP_ADDRESS, hederaAccountId: TEST_SHOP_ACCOUNT, hcsWriters: [TEST_SHOP_ACCOUNT], displayName: 'Test Shop' },
];

export const ASKED_CAP = { brand: 'Northwind', size: 'One size', colour: 'Red', quantity: '1', price: '2.00', merchant: 'Test Shop' };

/**
 * The simulated mirror node, which also shows the transfers the fake facilitator landed without
 * telling the shop (`land_then_timeout`), by their Hedera transaction id. Transfers it settled
 * normally carry `fake-settlement:` ids that only the shop knows, so they are not shown here.
 */
function mirrorWithLanded(ledger: MemoryLedger, fake: FakeFacilitator): MirrorClient {
  return new MirrorClient('http://memory-mirror.invalid', async (input, init) => {
    const m = /\/transactions\/(\d+\.\d+\.\d+-\d+-\d+)$/.exec(new URL(input).pathname);
    const s = m ? fake.settled.find((x) => x.landed && mirrorTransactionId(x.hederaTxId) === m[1]) : undefined;
    if (!s) return ledger.fetch(input, init);
    const moves = [
      { account: s.payer, amount: `-${s.amount}` },
      { account: s.payTo, amount: s.amount },
    ];
    const hbar = s.asset === HBAR_ASSET_ID;
    const tx = {
      transaction_id: m![1],
      result: 'SUCCESS',
      consensus_timestamp: `${ledger.clock}.000000000`,
      name: 'CRYPTOTRANSFER',
      nonce: 0,
      scheduled: false,
      transfers: hbar ? moves : [],
      token_transfers: hbar ? [] : moves.map((x) => ({ ...x, token_id: s.asset })),
    };
    return new Response(JSON.stringify({ transactions: [tx] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

export async function world(options: { limits?: Partial<Limits>; priceAsset?: PriceAsset } = {}) {
  const fake = fakeFacilitator();
  const ledger = new MemoryLedger(Math.floor(Date.now() / 1000));
  ledger.createTopic(TOPIC);
  const ipfs = new MemoryIpfs();
  const priceAsset = options.priceAsset ?? 'usdc';
  const shop = await startTestShop(
    [fake],
    { priceAsset },
    { parties: PARTIES, reader: new TopicReader(ledger.mirror(), TOPIC), mirror: mirrorWithLanded(ledger, fake), now: () => ledger.clock },
  );
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
  const payerKey = PrivateKey.generateECDSA();
  const agentAccount = privateKeyToAccount(generatePrivateKey());
  const buyerAccount = privateKeyToAccount(generatePrivateKey());
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const pin = (bytes: Uint8Array) => pinDocument(bytes, ipfs.provider, ipfs.options());
  const journals: { close(): void }[] = [];

  function open(o: { fetchImpl?: FetchLike; submitter?: MemorySubmitterOptions } = {}) {
    const submitter = ledger.submitter(AGENT, o.submitter);
    const mirror = mirrorWithLanded(ledger, fake);
    const recordsJournal = Journal.open<RecordsJournalRow>(join(dir, 'records.jsonl'));
    const agentJournal = Journal.open<AgentRow>(join(dir, 'orders.jsonl'));
    journals.push(recordsJournal, agentJournal);
    const sleep = async (ms: number) => {
      ledger.clock += Math.max(1, Math.ceil(ms / 1000));
    };
    const records = new RecordsClient({
      role: 'agent',
      topicId: TOPIC,
      submitter,
      pin,
      reader: new TopicReader(mirror, TOPIC),
      mirror,
      journal: recordsJournal,
      now: () => ledger.clock,
      sleep,
    });
    const buyer = new Buyer({
      platform: PLATFORM,
      shop: { x402Base: `${shop.url}/x402/`, apiBase: shop.url, payTo: TEST_SHOP_ACCOUNT, shopAddress: TEST_SHOP_ADDRESS, source: 'test' },
      records,
      pin,
      payer: createClientHederaSigner(AGENT, payerKey, { network: 'hedera:testnet' }),
      agentAccount,
      mirror,
      journal: agentJournal,
      limits,
      asset: priceAssetIdOf(priceAsset),
      log: memoryLogger(),
      now: () => ledger.clock,
      sleep,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    });
    return { buyer, records, submitter };
  }

  return {
    fake,
    ledger,
    ipfs,
    pin,
    shop,
    dir,
    agentAccount,
    buyerAccount,
    limits,
    open,
    close: async () => {
      for (const j of journals) j.close();
      await shop.close();
    },
  };
}

/** Reads a committed document back from the simulated IPFS by its CID. */
export async function docAt(w: Awaited<ReturnType<typeof world>>, cid: string): Promise<Record<string, unknown>> {
  const res = await w.ipfs.fetch(`http://memory-gateway.invalid/ipfs/${cid}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))) as Record<string, unknown>;
}

export type World = Awaited<ReturnType<typeof world>>;
export type { Hex };
