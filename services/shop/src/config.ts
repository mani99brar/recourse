// Shop configuration, from the environment only. Key material is never read here; key file paths
// are passed on to the loaders by env var name.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Address } from 'viem';
import { addressBook, partyByRole, priceAssetOf, type PriceAsset } from '@recourse/shared';
import { readParties } from '@recourse/shared/node';
import { displayNameOf, hederaAccountOf, recordsTopicId } from '@recourse/records';
import { deploymentsDir } from './chain.js';
import { parseFacilitatorUrls } from './facilitators.js';

type Env = Record<string, string | undefined>;

export type { PriceAsset };
export type StandingCheck = 'off' | 'vault';

export interface ShopConfig {
  port: number;
  /** Public base URL behind the proxy, if known. Used in the registration document. */
  publicUrl: string | null;
  /** The shop's Hedera account id (`0.0.N`), the x402 payTo. */
  payTo: string;
  payToSource: string;
  facilitatorUrls: string[];
  priceAsset: PriceAsset;
  mirrorUrl: string;
  /** The shop's journals: SHOP_STATE_DIR, else the default the caller gives. */
  stateDir: string;
  standingCheck: StandingCheck;
  /** Why the standing check is on or off: SHOP_STANDING_CHECK, or the default and its reason. */
  standingCheckSource: string;
  topicId: string | null;
  displayName: string;
  /** The shop's EVM address (the order id's shop), from the party map; null until it exists. */
  shopAddress: Address | null;
}

export function loadShopConfig(env: Env = process.env, defaults: { stateDir: string }): ShopConfig {
  const port = Number(env.SHOP_PORT ?? '8720');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('SHOP_PORT: not a port number');
  const priceAsset = priceAssetOf(env);
  const { standingCheck, standingCheckSource } = standingCheckOf(env);
  const shop = hederaAccountOf('shop', env);
  return {
    port,
    publicUrl: env.SHOP_PUBLIC_URL ? env.SHOP_PUBLIC_URL.replace(/\/+$/, '') : null,
    payTo: shop.accountId,
    payToSource: shop.source,
    facilitatorUrls: parseFacilitatorUrls(env.X402_FACILITATOR_URLS),
    priceAsset,
    mirrorUrl: env.HEDERA_MIRROR_URL || addressBook.hedera.mirrorUrl,
    stateDir: stateDirOf(env, defaults.stateDir),
    standingCheck,
    standingCheckSource,
    topicId: topicIdOrNull(env),
    displayName: displayNameOf('shop', env),
    shopAddress: env.PARTIES_FILE && existsSync(env.PARTIES_FILE) ? partyByRole(readParties(env), 'shop', env).evmAddress : null,
  };
}

/**
 * Where the shop's journals live (payments, records, claims): SHOP_STATE_DIR when set, else
 * `fallback`. The service, `pack`, `file-claim`, `reconcile` and the agent's `live-order` and
 * `pay-once` all resolve it this way, so they read and write the same files.
 */
export function stateDirOf(env: Env, fallback: string): string {
  return env.SHOP_STATE_DIR ? resolve(env.SHOP_STATE_DIR) : fallback;
}

/**
 * SHOP_STANDING_CHECK when set. Otherwise `vault` once the Hedera deployment is recorded
 * (deployments/hedera.json) and HEDERA_RPC_URL_1 names a relay to read the vault through, so a
 * deployed shop sells only to platforms in good standing; `off` before that.
 */
export function standingCheckOf(env: Env): { standingCheck: StandingCheck; standingCheckSource: string } {
  const raw = env.SHOP_STANDING_CHECK;
  if (raw !== undefined && raw !== '') {
    const standingCheck = raw.toLowerCase();
    if (standingCheck !== 'off' && standingCheck !== 'vault') throw new Error('SHOP_STANDING_CHECK: expected off or vault');
    return { standingCheck, standingCheckSource: 'SHOP_STANDING_CHECK' };
  }
  const record = join(deploymentsDir(env), 'hedera.json');
  if (!existsSync(record)) return { standingCheck: 'off', standingCheckSource: `default: ${record} does not exist` };
  if (!env.HEDERA_RPC_URL_1) return { standingCheck: 'off', standingCheckSource: 'default: HEDERA_RPC_URL_1 is not set' };
  return { standingCheck: 'vault', standingCheckSource: `default: ${record} exists` };
}

function topicIdOrNull(env: Env): string | null {
  try {
    return recordsTopicId(env);
  } catch {
    return null;
  }
}
