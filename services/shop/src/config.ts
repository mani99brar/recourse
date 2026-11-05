// Shop configuration, from the environment only. Key material is never read here; key file paths
// are passed on to the loaders by env var name.

import { addressBook } from '@recourse/shared';
import { hederaAccountOf } from '@recourse/records';
import { parseFacilitatorUrls } from './facilitators.js';

type Env = Record<string, string | undefined>;

export type PriceAsset = 'usdc' | 'hbar';
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
  stateDir: string;
  standingCheck: StandingCheck;
  topicId: string | null;
  displayName: string;
}

export function loadShopConfig(env: Env = process.env, defaults: { stateDir: string }): ShopConfig {
  const port = Number(env.SHOP_PORT ?? '8720');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('SHOP_PORT: not a port number');
  const priceAsset = (env.PRICE_ASSET ?? 'usdc').toLowerCase();
  if (priceAsset !== 'usdc' && priceAsset !== 'hbar') throw new Error('PRICE_ASSET: expected usdc or hbar');
  const standingCheck = (env.SHOP_STANDING_CHECK ?? 'off').toLowerCase();
  if (standingCheck !== 'off' && standingCheck !== 'vault') throw new Error('SHOP_STANDING_CHECK: expected off or vault');
  const shop = hederaAccountOf('shop', env);
  return {
    port,
    publicUrl: env.SHOP_PUBLIC_URL ? env.SHOP_PUBLIC_URL.replace(/\/+$/, '') : null,
    payTo: shop.accountId,
    payToSource: shop.source,
    facilitatorUrls: parseFacilitatorUrls(env.X402_FACILITATOR_URLS),
    priceAsset,
    mirrorUrl: env.HEDERA_MIRROR_URL || addressBook.hedera.mirrorUrl,
    stateDir: env.SHOP_STATE_DIR || defaults.stateDir,
    standingCheck,
    topicId: env.HCS_RECORDS_TOPIC_ID || null,
    displayName: env.SHOP_DISPLAY_NAME || 'Demo Shop',
  };
}
