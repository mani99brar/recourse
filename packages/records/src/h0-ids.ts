// The setup ids file, `packages/records/h0-ids.json`: the HCS records topic, the two ERC-8004
// identities and, per party, its EVM owner address and Hedera payer accounts. The party map
// (deployments/parties.json) is built from it. All values are public.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseParties, type Parties } from '@recourse/shared';

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

/** The env file services load: RECOURSE_ENV_FILE, else ~/.config/recourse/recourse.env. */
export function recourseEnvFile(env: Record<string, string | undefined> = process.env): string {
  return env.RECOURSE_ENV_FILE || join(homedir(), '.config/recourse/recourse.env');
}

/** Sets `NAME=value` in env file text: replaces every existing line for NAME, else appends one. */
export function upsertEnvLine(text: string, name: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n]/.test(value)) throw new Error(`env line ${name}: bad name or value`);
  const kept = text.split('\n').filter((line) => !line.startsWith(`${name}=`));
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return `${[...kept, `${name}=${value}`].join('\n')}\n`;
}

/** The party map with the registered agent ids set on the platform and shop entries. */
export function partiesWithAgentIds(parties: Parties, ids: H0Ids): Parties {
  return parties.map((p) => {
    const agent = p.role === 'platform' ? ids.agents.platform : p.role === 'shop' ? ids.agents.shop : undefined;
    return agent ? { ...p, agentId: agent.agentId } : p;
  });
}

export interface IdsPublication {
  /** What changed or would change, one line each. */
  changes: string[];
  /** Why something could not be written yet. */
  pending: string[];
}

/**
 * Writes the setup ids where the services read them: HCS_RECORDS_TOPIC_ID into the env file, the
 * agent ids into the party map (PARTIES_FILE). With `write` false it only reports. Each file is
 * rewritten atomically and only when its content changes; nothing else in either file is touched.
 */
export function publishIds(ids: H0Ids, options: { env?: Record<string, string | undefined>; write: boolean }): IdsPublication {
  const env = options.env ?? process.env;
  const out: IdsPublication = { changes: [], pending: [] };
  const envFile = recourseEnvFile(env);
  if (ids.topic) {
    const before = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    const after = upsertEnvLine(before, 'HCS_RECORDS_TOPIC_ID', ids.topic.topicId);
    if (after !== before) {
      out.changes.push(`${envFile}: HCS_RECORDS_TOPIC_ID=${ids.topic.topicId}`);
      if (options.write) writeAtomic(envFile, after, 0o600);
    }
  } else {
    out.pending.push('no records topic yet');
  }
  const partiesFile = env.PARTIES_FILE;
  if (!partiesFile || !existsSync(partiesFile)) {
    out.pending.push(`PARTIES_FILE ${partiesFile ?? '(not set)'} does not exist yet; the agent ids stay in ${H0_IDS_PATH} until it does`);
    return out;
  }
  const raw = JSON.parse(readFileSync(partiesFile, 'utf8')) as unknown;
  const parsed = parseParties(raw);
  if (!parsed.ok) throw new Error(`PARTIES_FILE: ${parsed.error}`);
  const updated = partiesWithAgentIds(parsed.value, ids);
  for (const [i, p] of updated.entries()) {
    if (p.agentId !== parsed.value[i]!.agentId) out.changes.push(`${partiesFile}: ${p.role} agentId ${p.agentId}`);
  }
  for (const role of ['platform', 'shop'] as const) {
    if (!ids.agents[role]) out.pending.push(`${role}: not registered yet`);
  }
  if (options.write && out.changes.some((c) => c.startsWith(`${partiesFile}:`))) {
    const check = parseParties(updated);
    if (!check.ok) throw new Error(`PARTIES_FILE after update: ${check.error}`);
    writeAtomic(partiesFile, `${JSON.stringify(updated, null, 2)}\n`, 0o644);
  }
  return out;
}

function writeAtomic(path: string, text: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}
