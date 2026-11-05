import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readParties } from '@recourse/shared/node';
import { publishIds, upsertEnvLine, type H0Ids } from '../src/h0-ids.js';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

const IDS: H0Ids = {
  v: 1,
  network: 'hedera:testnet',
  chainId: 296,
  topic: { topicId: '0.0.7123456', memo: 'recourse.records.v1', adminKey: null, submitKey: null, txId: '0.0.5@1.2', createdAt: 'x' },
  agents: {
    platform: { agentId: '41', owner: A(1), agentUri: 'data:', uriKind: 'data', txHash: '0x', registeredAt: 'x' },
    shop: { agentId: '42', owner: A(2), agentUri: 'data:', uriKind: 'data', txHash: '0x', registeredAt: 'x' },
  },
  parties: [],
};

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'ids-'));
  const envFile = join(dir, 'recourse.env');
  const partiesFile = join(dir, 'parties.json');
  writeFileSync(envFile, 'HEDERA_RPC_URL_1=https://rpc.example\nHCS_RECORDS_TOPIC_ID=0.0.1\nAGENT_PORT=8722\n', { mode: 0o600 });
  writeFileSync(
    partiesFile,
    JSON.stringify([
      { role: 'platform', evmAddress: A(1), hederaAccountId: '0.0.11', hcsWriters: ['0.0.12'], displayName: 'P' },
      { role: 'agent', evmAddress: A(3), hederaAccountId: '0.0.12', hcsWriters: [], displayName: 'A' },
      { role: 'shop', evmAddress: A(2), hederaAccountId: '0.0.13', hcsWriters: ['0.0.13'], displayName: 'S' },
    ]),
  );
  return { envFile, partiesFile, env: { RECOURSE_ENV_FILE: envFile, PARTIES_FILE: partiesFile } };
}

describe('setup ids', () => {
  it('replaces or appends one env line and leaves the rest alone', () => {
    expect(upsertEnvLine('A=1\nB=2\n', 'B', '3')).toBe('A=1\nB=3\n');
    expect(upsertEnvLine('A=1', 'C', '4')).toBe('A=1\nC=4\n');
    expect(upsertEnvLine('', 'C', '4')).toBe('C=4\n');
    expect(() => upsertEnvLine('', 'C', 'x\ny')).toThrow();
  });

  it('reports without writing in a dry run, then writes the topic and agent ids', () => {
    const f = files();
    const envBefore = readFileSync(f.envFile, 'utf8');
    const partiesBefore = readFileSync(f.partiesFile, 'utf8');
    const dry = publishIds(IDS, { env: f.env, write: false });
    expect(dry.changes).toEqual([
      `${f.envFile}: HCS_RECORDS_TOPIC_ID=0.0.7123456`,
      `${f.partiesFile}: platform agentId 41`,
      `${f.partiesFile}: shop agentId 42`,
    ]);
    expect(readFileSync(f.envFile, 'utf8')).toBe(envBefore);
    expect(readFileSync(f.partiesFile, 'utf8')).toBe(partiesBefore);

    publishIds(IDS, { env: f.env, write: true });
    expect(readFileSync(f.envFile, 'utf8')).toBe('HEDERA_RPC_URL_1=https://rpc.example\nAGENT_PORT=8722\nHCS_RECORDS_TOPIC_ID=0.0.7123456\n');
    expect(statSync(f.envFile).mode & 0o777).toBe(0o600);
    const parties = readParties({ PARTIES_FILE: f.partiesFile });
    expect(parties.map((p) => [p.role, p.agentId])).toEqual([
      ['platform', '41'],
      ['agent', undefined],
      ['shop', '42'],
    ]);
    expect(publishIds(IDS, { env: f.env, write: true }).changes).toEqual([]);
  });

  it('waits for the party map when it does not exist yet', () => {
    const f = files();
    const out = publishIds(IDS, { env: { ...f.env, PARTIES_FILE: join(f.partiesFile, '..', 'missing.json') }, write: true });
    expect(out.pending.join(' ')).toMatch(/does not exist yet/);
  });
});
