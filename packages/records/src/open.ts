// Builds a records client for a running service from its environment: the records topic, the
// writer's Hedera account and key, the mirror node, the pin provider and the journal. Fails at
// start, naming what is missing, rather than on the first commit.

import { ENV_DEFAULTS } from '@recourse/shared';
import { loadKeyBytes } from '@recourse/shared/node';
import { hederaAccountOf } from './accounts.js';
import { readH0Ids } from './h0-ids.js';
import { SdkHcsSubmitter } from './hcs.js';
import { ipfsOptionsFromEnv, pinDocument, pinProviderFromEnv } from './ipfs.js';
import { Journal } from './journal.js';
import type { Logger } from './log.js';
import { MirrorClient } from './mirror.js';
import { RecordsClient, type RecordsJournalRow, type WriterRole } from './records-client.js';
import { TopicReader } from './topic.js';

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
  payer: string;
  topicId: string;
  close(): void;
}

export function openRecordsClient(options: { role: WriterRole; journalPath: string; env?: Env; log?: Logger }): OpenedRecords {
  const env = options.env ?? process.env;
  const topicId = recordsTopicId(env);
  const provider = pinProviderFromEnv(env);
  const ipfs = ipfsOptionsFromEnv(env);
  const payer = hederaAccountOf(options.role, env).accountId;
  const submitter = SdkHcsSubmitter.fromKeyBytes(payer, loadKeyBytes(options.role === 'agent' ? 'AGENT_KEY_FILE' : 'SHOP_KEY_FILE', env));
  const mirror = mirrorFromEnv(env);
  const reader = new TopicReader(mirror, topicId);
  const journal = Journal.open<RecordsJournalRow>(options.journalPath);
  const client = new RecordsClient({
    role: options.role,
    topicId,
    submitter,
    pin: (bytes) => pinDocument(bytes, provider, ipfs),
    reader,
    mirror,
    journal,
    log: options.log,
  });
  return {
    client,
    reader,
    mirror,
    payer,
    topicId,
    close: () => {
      submitter.close();
      journal.close();
    },
  };
}
