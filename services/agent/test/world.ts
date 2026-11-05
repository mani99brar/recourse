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
import type { Parties } from '@recourse/shared';
import {
  Journal,
  MemoryIpfs,
  MemoryLedger,
  RecordsClient,
  TopicReader,
  memoryLogger,
  pinDocument,
  type MemorySubmitterOptions,
  type RecordsJournalRow,
} from '@recourse/records';
import { USDC_TOKEN_ID } from '../../shop/src/payments.js';
import { fakeFacilitator } from '../../shop/test/fake-facilitator.js';
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

export async function world(options: { limits?: Partial<Limits> } = {}) {
  const fake = fakeFacilitator();
  const ledger = new MemoryLedger(Math.floor(Date.now() / 1000));
  ledger.createTopic(TOPIC);
  const ipfs = new MemoryIpfs();
  const shop = await startTestShop([fake], {}, { parties: PARTIES, reader: new TopicReader(ledger.mirror(), TOPIC) });
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
  const payerKey = PrivateKey.generateECDSA();
  const agentAccount = privateKeyToAccount(generatePrivateKey());
  const buyerAccount = privateKeyToAccount(generatePrivateKey());
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const pin = (bytes: Uint8Array) => pinDocument(bytes, ipfs.provider, ipfs.options());
  const journals: { close(): void }[] = [];

  function open(o: { fetchImpl?: FetchLike; submitter?: MemorySubmitterOptions } = {}) {
    const submitter = ledger.submitter(AGENT, o.submitter);
    const mirror = ledger.mirror();
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
      asset: USDC_TOKEN_ID,
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
