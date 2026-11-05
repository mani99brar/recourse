// Docket configuration: environment names, defaults and parsing. Keys are never read here; the
// entry point loads the writer's key from its key file.

import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

export interface DocketConfig {
  port: number;
  stateDir: string;
  store: 'arkiv' | 'local';
  publishThreshold: number;
  sampleMode: boolean;
  z: number;
  pollSeconds: number;
  retrySeconds: number;
  retryMax: number;
  lifetimeDays: number;
  pageSize: number;
  mirrorUrl: string;
  arkivRpcUrl: string | undefined;
  arkivAccessKey: string;
  alertUrl: string | undefined;
  reviewsEnabled: boolean;
  reviewValueFault: number;
  reviewValueClear: number;
  reviewTag1: string;
  minTglm: number;
  minHbar: number;
  deploymentsDir: string | undefined;
}

function num(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name}: expected a number of at least ${min}`);
  return n;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|on|yes)$/i.test(raw)) return true;
  if (/^(0|false|off|no)$/i.test(raw)) return false;
  throw new Error(`${name}: expected true or false`);
}

export function loadConfig(env: Env = process.env): DocketConfig {
  const store = env.DOCKET_STORE === undefined || env.DOCKET_STORE === '' ? 'local' : env.DOCKET_STORE;
  if (store !== 'arkiv' && store !== 'local') throw new Error('DOCKET_STORE: expected arkiv or local');
  const accessKey = env.ARKIV_ACCESS_KEY ?? '';
  if (store === 'arkiv' && accessKey === '') {
    throw new Error('DOCKET_STORE=arkiv needs ARKIV_ACCESS_KEY; unset DOCKET_STORE to run on the local store');
  }
  return {
    port: num(env, 'DOCKET_PORT', 8707, 1),
    stateDir: env.DOCKET_STATE_DIR || join(homedir(), '.local/state/recourse/docket'),
    store,
    publishThreshold: num(env, 'DOCKET_PUBLISH_THRESHOLD', 20, 1),
    sampleMode: flag(env, 'DOCKET_SAMPLE_MODE', true),
    z: num(env, 'DOCKET_Z', 1.96, 0.1),
    pollSeconds: num(env, 'DOCKET_POLL_SECONDS', 15, 1),
    retrySeconds: num(env, 'DOCKET_RETRY_SECONDS', 600, 1),
    retryMax: num(env, 'DOCKET_RETRY_MAX', 5, 1),
    lifetimeDays: num(env, 'ARKIV_LIFETIME_DAYS', 182, 1),
    pageSize: Math.min(100, num(env, 'ARKIV_PAGE_SIZE', 100, 1)),
    mirrorUrl: env.HEDERA_MIRROR_URL || 'https://testnet.mirrornode.hedera.com',
    arkivRpcUrl: env.ARKIV_RPC_URL || undefined,
    arkivAccessKey: accessKey,
    alertUrl: env.ALERT_URL || undefined,
    // Off until the reviewer wallet is funded and the operator switches it on.
    reviewsEnabled: flag(env, 'REVIEWS_ENABLED', false),
    reviewValueFault: num(env, 'REVIEW_VALUE_FAULT', -100, -1e9),
    reviewValueClear: num(env, 'REVIEW_VALUE_CLEAR', 0, -1e9),
    reviewTag1: env.REVIEW_TAG1 || 'recourse',
    minTglm: num(env, 'ARKIV_MIN_TGLM', 1),
    minHbar: num(env, 'SCHEME_MIN_HBAR', 5),
    deploymentsDir: env.DEPLOYMENTS_DIR || undefined,
  };
}
