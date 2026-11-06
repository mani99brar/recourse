import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { memoryLogger } from '@recourse/records';
import { DEFAULT_STATE_DIR, assertShopJournal, shopParties, shopStateDir } from '../src/boot.js';
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

describe('party map', () => {
  const log = memoryLogger();

  test('a PARTIES_FILE that names no file stops the shop', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'shop-parties-')), 'parites.json');
    expect(() => shopParties({ PARTIES_FILE: missing }, log)).toThrow('PARTIES_FILE');
  });

  test('no PARTIES_FILE stops the shop unless SHOP_ALLOW_NO_PARTIES=1 says it is a local run', () => {
    expect(() => shopParties({}, log)).toThrow('SHOP_ALLOW_NO_PARTIES=1');
    expect(() => shopParties({ SHOP_ALLOW_NO_PARTIES: 'yes' }, log)).toThrow('PARTIES_FILE: not set');
    expect(shopParties({ SHOP_ALLOW_NO_PARTIES: '1' }, log)).toBeNull();
  });

  test('reads the party map it names', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shop-parties-')), 'parties.json');
    const parties = [
      { role: 'platform', evmAddress: '0x00000000000000000000000000000000000000A1', hederaAccountId: '0.0.990001', hcsWriters: ['0.0.990300'], displayName: 'Demo Agent Co' },
      { role: 'shop', evmAddress: '0x00000000000000000000000000000000000000b2', hederaAccountId: '0.0.990100', hcsWriters: ['0.0.990100'], displayName: 'Test Shop' },
    ];
    writeFileSync(path, JSON.stringify(parties));
    expect(shopParties({ PARTIES_FILE: path }, log)?.map((p) => p.role)).toEqual(['platform', 'shop']);
  });
});
