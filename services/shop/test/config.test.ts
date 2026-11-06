import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadShopConfig } from '../src/config.js';

const BASE = { HEDERA_ACCOUNT_IDS: 'shop=0.0.990100', X402_FACILITATOR_URLS: 'https://facilitator.invalid', HCS_RECORDS_TOPIC_ID: '0.0.7000001' };
const RPC = { HEDERA_RPC_URL_1: 'http://relay.invalid' };

function deploymentsDir(withRecord: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'shop-deployments-'));
  if (withRecord) writeFileSync(join(dir, 'hedera.json'), '{}');
  return dir;
}

const check = (env: Record<string, string>) => loadShopConfig(env, { stateDir: '/nonexistent' }).standingCheck;

describe('vault standing check', () => {
  test('is on by default once the Hedera deployment is recorded and a relay is configured', () => {
    expect(check({ ...BASE, ...RPC, DEPLOYMENTS_DIR: deploymentsDir(true) })).toBe('vault');
    expect(check({ ...BASE, ...RPC, DEPLOYMENTS_DIR: deploymentsDir(true), SHOP_STANDING_CHECK: '' })).toBe('vault');
  });

  test('is off by default with no deployment record or no relay to read it through', () => {
    expect(check({ ...BASE, ...RPC, DEPLOYMENTS_DIR: deploymentsDir(false) })).toBe('off');
    expect(check({ ...BASE, DEPLOYMENTS_DIR: deploymentsDir(true) })).toBe('off');
  });

  test('SHOP_STANDING_CHECK wins either way', () => {
    expect(check({ ...BASE, ...RPC, DEPLOYMENTS_DIR: deploymentsDir(true), SHOP_STANDING_CHECK: 'off' })).toBe('off');
    expect(check({ ...BASE, DEPLOYMENTS_DIR: deploymentsDir(false), SHOP_STANDING_CHECK: 'VAULT' })).toBe('vault');
    expect(() => check({ ...BASE, SHOP_STANDING_CHECK: 'maybe' })).toThrow('SHOP_STANDING_CHECK: expected off or vault');
  });
});
