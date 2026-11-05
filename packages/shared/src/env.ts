// Environment variable names. Values never live in git (see .env.example). Key variables hold
// absolute paths to keystore files, never keys.

export const ENV_NAMES = [
  // chains and data sources
  'HEDERA_RPC_URL_1',
  'HEDERA_RPC_URL_2',
  'HEDERA_MIRROR_URL',
  'ARB_RPC_URL',
  'ARKIV_RPC_URL',
  'ARKIV_ACCESS_KEY',
  'X402_FACILITATOR_URLS',
  'IPFS_PIN_API_URL',
  'IPFS_PIN_API_KEY',
  'IPFS_PIN_API_SECRET',
  'IPFS_PIN_BUCKET',
  'IPFS_GATEWAY_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'HCS_RECORDS_TOPIC_ID',
  'ALERT_URL',
  'SOURCIFY_VERIFIER_URL',
  // keys
  'KEYSTORE_DIR',
  'DEPLOYER_KEY_FILE',
  'OPS_HEDERA_KEY_FILE',
  'OPS_ARB_KEY_FILE',
  'PRECHECK_SIGNER_KEY_FILE',
  'PLATFORM_KEY_FILE',
  'AGENT_KEY_FILE',
  'SHOP_KEY_FILE',
  'SCHEME_KEY_FILE',
  'BUYER_KEY_FILE',
  'FACILITATOR_KEY_FILE',
  // parties, deployments, tooling
  'HEDERA_ACCOUNT_IDS',
  'DEPLOYMENTS_DIR',
  'PARTIES_FILE',
  'SUITE_LOCK_FILE',
  // contract deploy inputs
  'RULING_RELAYER_ADDRESS',
  'PRECHECK_SIGNER_ADDRESS',
  'POOL_ADDRESS',
  'ANVIL_PORT_HEDERA',
  // agent and shop
  'AGENT_SPEND_LIMIT_USDC',
  'AGENT_MAX_ORDER_USDC',
  'AGENT_DAILY_CAP_USDC',
  'AGENT_APPROVAL_TTL_SEC',
  'PRICE_ASSET',
  'SHOP_PUBLIC_URL',
  'SHOP_BASE_URL',
  'SHOP_PORT',
  'AGENT_PORT',
  'SHOP_STANDING_CHECK',
  // precheck and keeper
  'PRECHECK_STATE_DIR',
  'PRECHECK_PORT',
  'KEEPER_STATE_DIR',
  'KEEPER_PORT',
  'KEEPER_REFILE_HOLD_MIN',
  'KEEPER_ARB_CONFIRMATIONS',
  'KEEPER_POLL_MS',
  'KEEPER_AUTO_MANUAL_EXEC',
  // docket and intake
  'DOCKET_PORT',
  'DOCKET_STATE_DIR',
  'DOCKET_STORE',
  'DOCKET_PUBLISH_THRESHOLD',
  'DOCKET_SAMPLE_MODE',
  'DOCKET_Z',
  'DOCKET_POLL_SECONDS',
  'DOCKET_RETRY_SECONDS',
  'DOCKET_RETRY_MAX',
  'ARKIV_LIFETIME_DAYS',
  'ARKIV_PAGE_SIZE',
  'ARKIV_MIN_TGLM',
  'SCHEME_MIN_HBAR',
  'REVIEWS_ENABLED',
  'REVIEW_VALUE_FAULT',
  'REVIEW_VALUE_CLEAR',
  'REVIEW_TAG1',
  'INTAKE_PORT',
  'INTAKE_CORS_ORIGIN',
  'INTAKE_MAX_BYTES',
  'INTAKE_RATE_PER_MIN',
  'INTAKE_LLM_TIMEOUT_MS',
  'INTAKE_LLM_PAUSE_MIN',
  // status api
  'STATUS_API_PORT',
  'STATUS_API_STATE_DIR',
  'POLL_MS',
  'ARB_CONFIRMATIONS',
  'ARB_LOG_CHUNK',
  'SOURCE_TIMEOUT_MS',
  'VIEW_CACHE_MS',
  'LAG_WARN_S_HEDERA',
  'LAG_WARN_S_ARB',
  'LAG_WARN_S_HCS',
  'IPFS_RATE_PER_MIN',
  'DOCKET_URL',
  'INTAKE_URL',
  'AGENT_URL',
  'PRECHECK_URL',
  'WEB_ORIGIN',
] as const;
export type EnvName = (typeof ENV_NAMES)[number];

/** Public build-time values for apps/web. Listed in .env.example; readEnv never reads them. */
export const VITE_ENV_NAMES = ['VITE_STATUS_API_URL', 'VITE_ARKIV_PUBLIC_RPC_URL', 'VITE_POLL_MS'] as const;

/** Defaults for optional names; a name without a default here is required unless the caller passes one. */
export const ENV_DEFAULTS: Partial<Record<EnvName, string>> = {
  HEDERA_MIRROR_URL: 'https://testnet.mirrornode.hedera.com',
  SUITE_LOCK_FILE: '/home/agentops/.local/state/recourse/suite.lock',
};

type Env = Record<string, string | undefined>;

function defaultEnv(): Env {
  const p = (globalThis as { process?: { env?: Env } }).process;
  return p?.env ?? {};
}

/**
 * Reads the named variables. A value comes from the environment, else from `defaults`, else from
 * ENV_DEFAULTS; a name with none of these fails, naming the variable and never echoing a value.
 */
export function readEnv<N extends EnvName>(
  names: readonly N[],
  options: { defaults?: Partial<Record<N, string>>; env?: Env } = {},
): Record<N, string> {
  const env = options.env ?? defaultEnv();
  const out = {} as Record<N, string>;
  const missing: string[] = [];
  for (const name of names) {
    if (!(ENV_NAMES as readonly string[]).includes(name)) throw new Error(`readEnv: ${name} is not a known env name`);
    const value = env[name];
    const fallback = options.defaults?.[name] ?? ENV_DEFAULTS[name];
    if (value !== undefined && value !== '') out[name] = value;
    else if (fallback !== undefined) out[name] = fallback;
    else missing.push(name);
  }
  if (missing.length > 0) throw new Error(`readEnv: missing ${missing.join(', ')}`);
  return out;
}
