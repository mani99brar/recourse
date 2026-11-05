// Shared fixtures for the records tests. Every account, name and order here is made up.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, type Hex } from 'viem';
import { RECORD_KEYS, canonicalBytes, type CanonicalValue, type Parties, type RecordKind } from '@recourse/shared';
import { Journal } from '../src/journal.js';
import { RecordsClient, type RecordsJournalRow, type WriterRole } from '../src/records-client.js';
import { MemoryIpfs, MemoryLedger, type MemorySubmitterOptions } from '../src/testing.js';
import { TopicReader } from '../src/topic.js';
import { pinDocument } from '../src/ipfs.js';

export const TOPIC = '0.0.7000001';
export const AGENT_PAYER = '0.0.2001';
export const SHOP_PAYER = '0.0.3001';
export const STRANGER = '0.0.4004';
export const ORDER: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111';
export const OTHER_ORDER: Hex = '0x2222222222222222222222222222222222222222222222222222222222222222';

export const PARTIES: Parties = [
  {
    role: 'platform',
    evmAddress: getAddress('0x00000000000000000000000000000000000000a1'),
    hederaAccountId: '0.0.1001',
    hcsWriters: [AGENT_PAYER],
    displayName: 'Demo Agent Co',
  },
  {
    role: 'shop',
    evmAddress: getAddress('0x00000000000000000000000000000000000000b2'),
    hederaAccountId: SHOP_PAYER,
    hcsWriters: [SHOP_PAYER],
    displayName: 'Demo Shop',
  },
];

/** A valid record document of the given kind for `orderId`; `variant` changes its contents. */
export function doc(kind: RecordKind, orderId: Hex = ORDER, variant = 0): Uint8Array {
  const key = RECORD_KEYS[kind];
  const base: Record<string, CanonicalValue> = { v: '1', kind: key, orderId };
  if (key === 'approval') return canonicalBytes({ ...base, approval: 'approved', approvalBasis: 'mandate', note: `n${variant}` });
  const attrs = { brand: 'Northwind', size: variant === 0 ? 'm' : 'l', colour: 'navy', quantity: '1', price: '42.00', merchant: 'Demo Shop' };
  if (key === 'shown') return canonicalBytes({ ...base, attrs, changes: [] });
  if (key === 'ordered') return canonicalBytes({ ...base, attrs, x402TxId: '0.0.2001@1800000000.000000001' });
  return canonicalBytes({ ...base, attrs });
}

export function tempJournalPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'records-test-')), 'records.jsonl');
}

export interface Harness {
  ledger: MemoryLedger;
  ipfs: MemoryIpfs;
  journalPath: string;
  open(options?: { role?: WriterRole; submitter?: MemorySubmitterOptions; payer?: string }): {
    client: RecordsClient;
    submitter: ReturnType<MemoryLedger['submitter']>;
    journal: Journal<RecordsJournalRow>;
    reader: TopicReader;
  };
}

/** One simulated ledger, gateway and journal file; `open` builds a client on them as a fresh process would. */
export function harness(): Harness {
  const ledger = new MemoryLedger();
  ledger.createTopic(TOPIC);
  const ipfs = new MemoryIpfs();
  const journalPath = tempJournalPath();
  return {
    ledger,
    ipfs,
    journalPath,
    open(options = {}) {
      const role = options.role ?? 'agent';
      const submitter = ledger.submitter(options.payer ?? (role === 'agent' ? AGENT_PAYER : SHOP_PAYER), options.submitter);
      const mirror = ledger.mirror();
      const reader = new TopicReader(mirror, TOPIC, 2);
      const journal = Journal.open<RecordsJournalRow>(journalPath);
      const client = new RecordsClient({
        role,
        topicId: TOPIC,
        submitter,
        pin: (bytes) => pinDocument(bytes, ipfs.provider, ipfs.options()),
        reader,
        mirror,
        journal,
        now: () => ledger.clock,
        // Waiting moves the simulated clock instead of real time.
        sleep: async (ms) => {
          ledger.clock += Math.max(1, Math.ceil(ms / 1000));
        },
        pollMs: 5000,
      });
      return { client, submitter, journal, reader };
    },
  };
}
