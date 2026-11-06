import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDeployments } from '../src/deployments.js';

const FACADE = '0x0000000000000000000000000000000000068cDa';
const MOCK = '0x1111111111111111111111111111111111111111';
const hedera = { chainId: 296, contracts: { claims: { address: '0x' + 'aa'.repeat(20) }, vault: { address: '0x' + 'bb'.repeat(20) } } };

function dir(files: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'status-deploy-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), JSON.stringify(body));
  return d;
}

describe('deployment files, vault token', () => {
  it('is Circle USDC for a record with no usdc key, and with no record at all', () => {
    expect(loadDeployments(dir({ 'hedera.json': hedera })).token).toMatchObject({ mode: 'circle', address: FACADE, label: 'USDC' });
    expect(loadDeployments(dir({})).token.mode).toBe('circle');
  });

  it('reads circle and mock mode from the record', () => {
    const circle = { mode: 'circle', address: FACADE, decimals: 6, tokenId: '0.0.429274' };
    expect(loadDeployments(dir({ 'hedera.json': { ...hedera, usdc: circle } })).token.mode).toBe('circle');
    const mock = { mode: 'mock', address: MOCK, decimals: 6, tokenId: null };
    expect(loadDeployments(dir({ 'hedera.json': { ...hedera, usdc: mock } })).token).toMatchObject({ mode: 'mock', address: MOCK, symbol: 'mUSDC', label: 'mUSDC (testnet mock)' });
  });

  it('refuses a record whose usdc object does not validate', () => {
    expect(() => loadDeployments(dir({ 'hedera.json': { ...hedera, usdc: { mode: 'other' } } }))).toThrow('mode must be circle or mock');
  });
});
