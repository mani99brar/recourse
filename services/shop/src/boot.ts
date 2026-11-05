// Builds and starts the shop from the environment. Shared by the long-running service and by the
// agent's one-shot payment check, which runs a shop in-process with a chosen facilitator rung.

import type { Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKeyBytes } from '@recourse/shared/node';
import { Journal, createLogger, hederaAccountOf, type Logger } from '@recourse/records';
import { createShopApp, type ShopApp, type ShopJournalRow } from './app.js';
import { loadShopConfig, type ShopConfig } from './config.js';
import { FacilitatorLadder, SELF_HOSTED, httpRung, type RungSpec } from './facilitators.js';
import { NETWORK } from './payments.js';
import { createSelfFacilitator } from './self-facilitator.js';

type Env = Record<string, string | undefined>;

export const DEFAULT_STATE_DIR = fileURLToPath(new URL('../state/', import.meta.url));

export function ladderRungs(config: ShopConfig, env: Env): RungSpec[] {
  return config.facilitatorUrls.map((url, i) =>
    url === SELF_HOSTED
      ? {
          index: i + 1,
          url,
          create: () =>
            createSelfFacilitator({
              network: NETWORK,
              feePayerAccountId: hederaAccountOf('facilitator', env).accountId,
              feePayerKeyBytes: loadKeyBytes('FACILITATOR_KEY_FILE', env),
              mirrorUrl: config.mirrorUrl,
            }),
        }
      : httpRung(i + 1, url),
  );
}

export interface RunningShop {
  config: ShopConfig;
  shop: ShopApp;
  ladder: FacilitatorLadder;
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export async function startShop(
  options: { env?: Env; log?: Logger; port?: number; host?: string; firstRung?: number; journalPath?: string } = {},
): Promise<RunningShop> {
  const env = options.env ?? process.env;
  const log = options.log ?? createLogger('shop');
  const config = loadShopConfig(env, { stateDir: DEFAULT_STATE_DIR });
  if (options.port !== undefined) config.port = options.port;
  const journal = Journal.open<ShopJournalRow>(options.journalPath ?? join(config.stateDir, 'journal.jsonl'));
  let shop: ShopApp | undefined;
  const ladder = new FacilitatorLadder(ladderRungs(config, env), {
    network: NETWORK,
    log,
    onSwitch: async () => {
      await shop?.initialize();
    },
  });
  await ladder.select(Math.max(0, (options.firstRung ?? 1) - 1));
  shop = createShopApp({ config, facilitator: ladder, journal, log });
  await shop.initialize();
  log.info('shop_config', {
    payTo: config.payTo,
    payToSource: config.payToSource,
    priceAsset: config.priceAsset,
    standingCheck: config.standingCheck,
    topicId: config.topicId,
  });
  const host = options.host ?? '127.0.0.1';
  const server = await new Promise<Server>((resolve, reject) => {
    const s = shop!.app.listen(config.port, host, () => resolve(s));
    s.on('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${host}:${port}`;
  log.info('shop_listening', { url });
  return {
    config,
    shop,
    ladder,
    server,
    url,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      journal.close();
    },
  };
}
