// Builds a records client for a running service from its environment: the records topic, the
// writer's Hedera account and key, the mirror node, the pin client and the journal. Fails at
// start, naming what is missing, rather than on the first commit.

import { existsSync } from 'node:fs';
import { ENV_DEFAULTS } from '@recourse/shared';
import { loadKeyBytes, readParties } from '@recourse/shared/node';
import { assertRecordWriter, hederaAccountOf } from './accounts.js';
import { readH0Ids } from './h0-ids.js';
import { SdkHcsSubmitter } from './hcs.js';
import { openPinClient, type PinClient } from './ipfs.js';
import { Journal } from './journal.js';
import type { Logger } from './log.js';
import { MirrorClient } from './mirror.js';
import { RecordsClient, type RecordsJournalRow, type WriterRole } from './records-client.js';
import { TopicReader, writerFilter } from './topic.js';

type Env = Record<string, string | undefined>;

/** HCS_RECORDS_TOPIC_ID, else the topic the setup script wrote, else an error. */
export function recordsTopicId(env: Env = process.env): string {
  const fromEnv = env.HCS_RECORDS_TOPIC_ID?.trim();
  if (fromEnv) return fromEnv;
  const fromIds = readH0Ids()?.topic?.topicId;
  if (fromIds) return fromIds;
  throw new Error('records topic unknown: set HCS_RECORDS_TOPIC_ID or run the setup script');
}

export function mirrorFromEnv(env: Env = process.env): MirrorClient {
  return new MirrorClient(env.HEDERA_MIRROR_URL || ENV_DEFAULTS.HEDERA_MIRROR_URL!);
}

export interface OpenedRecords {
  client: RecordsClient;
  reader: TopicReader;
  mirror: MirrorClient;
  /** The pin client the records client pins with, for the service's other documents. */
  pins: PinClient;
  payer: string;
  topicId: string;
  close(): void;
}

export function openRecordsClient(options: { role: WriterRole; journalPath: string; env?: Env; log?: Logger }): OpenedRecords {
  const env = options.env ?? process.env;
  const topicId = recordsTopicId(env);
  const pins = openPinClient(env);
  const payer = hederaAccountOf(options.role, env).accountId;
  assertRecordWriter(options.role, payer, env);
  const submitter = SdkHcsSubmitter.fromKeyBytes(payer, loadKeyBytes(options.role === 'agent' ? 'AGENT_KEY_FILE' : 'SHOP_KEY_FILE', env));
  const mirror = mirrorFromEnv(env);
  // With the party map, only messages some party's writer paid for are kept (the topic is open to anyone).
  const reader = new TopicReader(mirror, topicId, env.PARTIES_FILE && existsSync(env.PARTIES_FILE) ? { keep: writerFilter(readParties(env)) } : {});
  const journal = Journal.open<RecordsJournalRow>(options.journalPath);
  const client = new RecordsClient({
    role: options.role,
    topicId,
    submitter,
    pin: (bytes) => pins.pin(bytes),
    reader,
    mirror,
    journal,
    log: options.log,
  });
  return {
    client,
    reader,
    mirror,
    pins,
    payer,
    topicId,
    close: () => {
      submitter.close();
      journal.close();
    },
  };
}
