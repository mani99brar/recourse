// TEST ONLY helpers: an in-process shop on a free port, wired to fake facilitators.

import type { Server } from 'node:http';
import { getAddress } from 'viem';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, memoryLogger } from '@recourse/records';
import { createShopApp, type ShopAppDeps, type ShopJournalRow } from '../src/app.js';
import type { ShopConfig } from '../src/config.js';
import { FacilitatorLadder } from '../src/facilitators.js';
import { NETWORK } from '../src/payments.js';
import type { FakeFacilitator } from './fake-facilitator.js';

export const TEST_SHOP_ACCOUNT = '0.0.990100';
export const TEST_SHOP_ADDRESS = getAddress('0x00000000000000000000000000000000000000b2');

export function testConfig(overrides: Partial<ShopConfig> = {}): ShopConfig {
  return {
    port: 0,
    publicUrl: null,
    payTo: TEST_SHOP_ACCOUNT,
    payToSource: 'test',
    facilitatorUrls: ['fake://1'],
    priceAsset: 'usdc',
    mirrorUrl: 'http://127.0.0.1:9/api/v1',
    stateDir: mkdtempSync(join(tmpdir(), 'shop-test-')),
    standingCheck: 'off',
    standingCheckSource: 'test',
    topicId: null,
    displayName: 'Test Shop',
    shopAddress: TEST_SHOP_ADDRESS,
    ...overrides,
  };
}

export async function startTestShop(
  fakes: FakeFacilitator[],
  overrides: Partial<ShopConfig> = {},
  extra: Pick<ShopAppDeps, 'parties' | 'standing' | 'reader' | 'mirror' | 'now'> = {},
) {
  const config = { ...testConfig(overrides), shopAddress: overrides.shopAddress ?? TEST_SHOP_ADDRESS };
  const log = memoryLogger();
  const journal = Journal.open<ShopJournalRow>(join(config.stateDir, 'journal.jsonl'));
  let initialize: (() => Promise<void>) | undefined;
  const ladder = new FacilitatorLadder(
    fakes.map((f, i) => ({ index: i + 1, url: `fake://${i + 1}`, create: () => f })),
    { network: NETWORK, log, onSwitch: async () => initialize?.() },
  );
  await ladder.select();
  const shop = createShopApp({ config, facilitator: ladder, journal, log, ...extra });
  initialize = shop.initialize;
  await shop.initialize();
  const server = await new Promise<Server>((resolve) => {
    const s = shop.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    url,
    config,
    journal,
    ladder,
    log,
    shop,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      journal.close();
    },
  };
}
