import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressBook } from '@recourse/shared';
import { DeploymentMissingError, readHederaDeployment } from '../src/chain.js';

// Fixture addresses: the records here are written by the tests, so no deployed contract is named.
const CLAIMS = '0x00000000000000000000000000000000000c1a1a';
const VAULT = '0x0000000000000000000000000000000000005a01';
// Circle's USDC on Hedera testnet, from the shared address book (the loader refuses it as a mock).
const FACADE = addressBook.hedera.usdc.facade;
const CIRCLE_ID = addressBook.hedera.usdc.tokenId;
const MOCK = '0x1111111111111111111111111111111111111111';
const LOCAL_MOCK = '0x2222222222222222222222222222222222222222';
const base = { chainId: 296, contracts: { claims: { address: CLAIMS }, vault: { address: VAULT } } };

function deployments(files: Record<string, unknown>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'shop-deploy-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body));
  return { DEPLOYMENTS_DIR: dir };
}

function thrown(f: () => unknown): Error {
  try {
    f();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

describe('hedera deployment, vault token', () => {
  it('is Circle USDC for a record with no usdc key', () => {
    const d = readHederaDeployment({ env: deployments({ 'hedera.json': base }) });
    expect(d.token).toMatchObject({ mode: 'circle', tokenId: CIRCLE_ID, label: 'USDC' });
    expect(d.usdc).toBe(FACADE);
  });

  it('reads circle mode from the record', () => {
    const usdc = { mode: 'circle', address: FACADE, decimals: 6, tokenId: CIRCLE_ID };
    const d = readHederaDeployment({ env: deployments({ 'hedera.json': { ...base, usdc } }) });
    expect(d.token.mode).toBe('circle');
    expect(d.usdc).toBe(FACADE);
  });

  it('takes the mock from the record and never the Circle facade', () => {
    const usdc = { mode: 'mock', address: MOCK.toLowerCase(), decimals: 6, tokenId: null };
    const d = readHederaDeployment({ env: deployments({ 'hedera.json': { ...base, usdc } }) });
    expect(d.token).toMatchObject({ mode: 'mock', address: MOCK, tokenId: null, symbol: 'mUSDC', label: 'mUSDC (testnet mock)' });
    expect(d.usdc).toBe(MOCK);
  });

  it('refuses a record whose usdc object does not validate', () => {
    const env = deployments({ 'hedera.json': { ...base, usdc: { mode: 'mock', address: MOCK, decimals: 6, tokenId: CIRCLE_ID } } });
    expect(() => readHederaDeployment({ env })).toThrow('tokenId must be null');
    const atFacade = deployments({ 'hedera.json': { ...base, usdc: { mode: 'mock', address: FACADE, decimals: 6, tokenId: null } } });
    expect(() => readHederaDeployment({ env: atFacade })).toThrow("cannot name Circle's facade");
  });

  it('tells a record that is not there yet from a bad one', () => {
    const missing = thrown(() => readHederaDeployment({ env: deployments({}) }));
    expect(missing).toBeInstanceOf(DeploymentMissingError);
    expect(missing.message).toMatch(/hedera\.json does not exist yet$/);
    const bad = thrown(() => readHederaDeployment({ env: deployments({ 'hedera.json': { ...base, usdc: { mode: 'hts' } } }) }));
    expect(bad.message).toContain('mode must be circle or mock');
    expect(bad).not.toBeInstanceOf(DeploymentMissingError);
  });

  it('keeps a local file on its local.usdc mock', () => {
    const local = { ...base, chainId: 31337, local: { usdc: LOCAL_MOCK } };
    const d = readHederaDeployment({ env: deployments({ 'x.local.json': local }), file: 'x.local.json' });
    expect(d.usdc).toBe(LOCAL_MOCK);
    expect(d.token.mode).toBe('circle');
  });

  it('refuses a local file whose local.usdc and usdc.address differ', () => {
    const local = { ...base, chainId: 31337, local: { usdc: LOCAL_MOCK }, usdc: { mode: 'mock', address: MOCK, decimals: 6, tokenId: null } };
    expect(() => readHederaDeployment({ env: deployments({ 'x.local.json': local }), file: 'x.local.json' })).toThrow('local.usdc');
    const same = { ...local, usdc: { ...local.usdc, address: LOCAL_MOCK } };
    expect(readHederaDeployment({ env: deployments({ 'x.local.json': same }), file: 'x.local.json' }).usdc).toBe(LOCAL_MOCK);
  });
});
