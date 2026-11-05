import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parseDeployment, topicNumOf } from '../src/config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CLAIMS = '0x00000000000000000000000000000000000c1a15';

function deployments(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'precheck-deploy-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, json] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(json));
  return dir;
}

const deployed = { contracts: { claims: { address: CLAIMS, id: '9.9.77' } }, startTimestamp: '1793901919.123456789' };

function env(dir: string): Record<string, string> {
  return {
    HEDERA_RPC_URL_1: 'http://rpc-one.example',
    HEDERA_MIRROR_URL: 'https://mirror.example',
    IPFS_GATEWAY_URL: 'https://gateway.example',
    HCS_RECORDS_TOPIC_ID: '9.9.500',
    PRECHECK_STATE_DIR: '/tmp/precheck-state',
    PRECHECK_PORT: '8705',
    DEPLOYMENTS_DIR: dir,
  };
}

describe('config', () => {
  it('reads the environment and the claims address and start timestamp from the deployments file', () => {
    const cfg = loadConfig(env(deployments({ 'hedera.json': deployed })));
    expect(cfg).toMatchObject({
      rpcUrls: ['http://rpc-one.example'],
      topicId: '9.9.500',
      topicNum: 500n,
      port: 8705,
      quietS: 120,
      pauseWindows: [],
      alertUrl: undefined,
      claimsAddress: getAddress(CLAIMS),
      startTimestamp: '1793901919.123456789',
    });
  });

  it('takes a second rpc url, pause windows and a quiet wait', () => {
    const cfg = loadConfig({
      ...env(deployments({ 'hedera.json': deployed })),
      HEDERA_RPC_URL_2: 'http://rpc-two.example',
      PRECHECK_QUIET_S: '30',
      SEND_PAUSE_WINDOWS: 'hedera@2026-11-06T17:45:00Z/2026-11-06T18:55:00Z',
    });
    expect(cfg.rpcUrls).toHaveLength(2);
    expect(cfg.quietS).toBe(30);
    expect(cfg.pauseWindows).toHaveLength(1);
  });

  it('names a missing variable without echoing values', () => {
    const e = env(deployments({ 'hedera.json': deployed }));
    delete e.PRECHECK_PORT;
    expect(() => loadConfig(e)).toThrow(/PRECHECK_PORT/);
  });

  it('reads a bare *.local.json override and refuses a path', () => {
    const dir = deployments({ 'hedera.local.json': { ...deployed, contracts: { claims: { address: CLAIMS, id: null } } } });
    expect(loadConfig(env(dir), { deploymentsFile: 'hedera.local.json' }).claimsAddress).toMatch(/^0x/);
    expect(() => loadConfig(env(dir), { deploymentsFile: '../hedera.local.json' })).toThrow(/bare/);
    expect(() => loadConfig(env(dir), { deploymentsFile: 'other.json' })).toThrow(/bare/);
  });

  it('rejects a deployment file with a bad shape', () => {
    expect(() => parseDeployment({ contracts: { claims: { address: 'nope' } }, startTimestamp: '1.0' })).toThrow(/address/);
    expect(() => parseDeployment({ contracts: { claims: { address: CLAIMS } }, startTimestamp: 1793901919 })).toThrow(/startTimestamp/);
  });

  it('takes the topic number from the topic id', () => {
    expect(topicNumOf('0.0.7')).toBe(7n);
    expect(() => topicNumOf('7')).toThrow(/HCS_RECORDS_TOPIC_ID/);
  });
});
