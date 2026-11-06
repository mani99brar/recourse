import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { getAddress, type Address } from 'viem';
import { priceAssetIdOf } from '@recourse/shared';
import { shopRegistration, toDataUri } from '@recourse/records';
import {
  DEFAULT_AGENT_STATE_DIR,
  RegistrationMismatchError,
  agentStateDir,
  discoverShop,
  ordersJournalPath,
  recordsJournalPath,
} from '../src/setup.js';

describe('agent state folder', () => {
  test('AGENT_STATE_DIR names it; unset or empty keeps the folder in the checkout', () => {
    expect(agentStateDir({ AGENT_STATE_DIR: '/var/tmp/agent-state' })).toBe('/var/tmp/agent-state');
    expect(ordersJournalPath({ AGENT_STATE_DIR: '/var/tmp/agent-state' })).toBe(join('/var/tmp/agent-state', 'orders.jsonl'));
    expect(recordsJournalPath({ AGENT_STATE_DIR: '/var/tmp/agent-state' })).toBe(join('/var/tmp/agent-state', 'records.jsonl'));
    expect(agentStateDir({ AGENT_STATE_DIR: '' })).toBe(DEFAULT_AGENT_STATE_DIR);
    expect(ordersJournalPath({})).toBe(join(DEFAULT_AGENT_STATE_DIR, 'orders.jsonl'));
    expect(DEFAULT_AGENT_STATE_DIR).toMatch(/services\/agent\/state\/?$/);
  });
});

const USDC_TOKEN_ID = priceAssetIdOf('usdc');
const SHOP = getAddress('0x00000000000000000000000000000000000000b2');
const OTHER = getAddress('0x00000000000000000000000000000000000000c3');

function partiesFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-parties-')), 'parties.json');
  writeFileSync(
    path,
    JSON.stringify([
      { role: 'platform', evmAddress: '0x00000000000000000000000000000000000000a1', hederaAccountId: '0.0.990001', hcsWriters: ['0.0.990300'], displayName: 'Demo Agent Co' },
      { role: 'shop', evmAddress: SHOP, hederaAccountId: '0.0.990100', hcsWriters: ['0.0.990100'], agentId: '42', displayName: 'Test Shop' },
    ]),
  );
  return path;
}

/** An identity registry whose token 42 points at a data: registration naming `payTo` and `asset`, owned by `owner`. */
function registry(doc: { payTo: string; asset: string; owner: Address }) {
  const uri = toDataUri(
    shopRegistration({ name: 'Test Shop', x402BaseUrl: 'https://shop.invalid/x402/', payTo: doc.payTo, asset: doc.asset, network: 'hedera:testnet' }),
  );
  return {
    readContract: (async ({ functionName }: { functionName: string }) => (functionName === 'tokenURI' ? uri : doc.owner)) as never,
  };
}

describe('shop discovery', () => {
  const env = () => ({ PARTIES_FILE: partiesFile(), PRICE_ASSET: 'usdc', SHOP_BASE_URL: 'https://fallback.invalid' });

  test('takes the registration when it names the party map shop', async () => {
    const shop = await discoverShop(env(), undefined, { client: registry({ payTo: '0.0.990100', asset: USDC_TOKEN_ID, owner: SHOP }) });
    expect(shop).toMatchObject({ payTo: '0.0.990100', shopAddress: SHOP, x402Base: 'https://shop.invalid/x402/', source: 'erc8004:42' });
  });

  test('stops, without falling back, when the registration names another account, asset or owner', async () => {
    for (const doc of [
      { payTo: '0.0.666', asset: USDC_TOKEN_ID, owner: SHOP },
      { payTo: '0.0.990100', asset: '0.0.0', owner: SHOP },
      { payTo: '0.0.990100', asset: USDC_TOKEN_ID, owner: OTHER },
    ]) {
      const err = await discoverShop(env(), undefined, { client: registry(doc) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RegistrationMismatchError);
    }
  });
});
