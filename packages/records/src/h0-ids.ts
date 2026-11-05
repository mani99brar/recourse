// The setup ids file, `packages/records/h0-ids.json`: the HCS records topic, the two ERC-8004
// identities and, per party, its EVM owner address and Hedera payer accounts. The party map
// (deployments/parties.json) is built from it. All values are public.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const H0_IDS_PATH = fileURLToPath(new URL('../h0-ids.json', import.meta.url));
export const RECORDS_TOPIC_MEMO = 'recourse.records.v1';

export interface H0Topic {
  topicId: string;
  memo: string;
  adminKey: null;
  submitKey: null;
  txId: string;
  createdAt: string;
}

export interface H0Agent {
  agentId: string;
  owner: string;
  agentUri: string;
  /** `data` (inline JSON), `https` or `ipfs`. */
  uriKind: string;
  txHash: string;
  registeredAt: string;
  uriUpdates?: { agentUri: string; txHash: string; at: string }[];
}

export interface H0Party {
  role: 'platform' | 'agent' | 'shop' | 'facilitator';
  evmAddress: string;
  hederaAccountId: string;
  hcsWriters: string[];
}

export interface H0Ids {
  v: 1;
  network: 'hedera:testnet';
  chainId: 296;
  topic?: H0Topic;
  agents: { platform?: H0Agent; shop?: H0Agent };
  parties: H0Party[];
}

export function readH0Ids(path = H0_IDS_PATH): H0Ids | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as H0Ids;
  if (parsed.v !== 1 || parsed.network !== 'hedera:testnet') throw new Error('h0-ids: unexpected version or network');
  return parsed;
}

/** Writes atomically (temp file, then rename), so a crash never leaves half a file. */
export function writeH0Ids(ids: H0Ids, path = H0_IDS_PATH): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
}
