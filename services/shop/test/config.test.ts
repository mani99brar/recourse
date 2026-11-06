import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEFAULT_STATE_DIR, assertShopJournal, shopStateDir } from '../src/boot.js';
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

describe('state folder', () => {
  test('SHOP_STATE_DIR names it; unset or empty keeps the folder in the checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shop-state-'));
    expect(loadShopConfig({ ...BASE, SHOP_STATE_DIR: dir }, { stateDir: DEFAULT_STATE_DIR }).stateDir).toBe(dir);
    expect(loadShopConfig({ ...BASE }, { stateDir: DEFAULT_STATE_DIR }).stateDir).toBe(DEFAULT_STATE_DIR);
    expect(shopStateDir({ SHOP_STATE_DIR: dir })).toBe(dir);
    expect(shopStateDir({ SHOP_STATE_DIR: '' })).toBe(DEFAULT_STATE_DIR);
    expect(shopStateDir({})).toBe(DEFAULT_STATE_DIR);
    expect(DEFAULT_STATE_DIR).toMatch(/services\/shop\/state\/?$/);
  });

  test('the scripts refuse a folder with no shop journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shop-state-'));
    expect(() => assertShopJournal(dir)).toThrow('set SHOP_STATE_DIR');
    writeFileSync(join(dir, 'journal.jsonl'), '');
    expect(() => assertShopJournal(dir)).not.toThrow();
  });
});
