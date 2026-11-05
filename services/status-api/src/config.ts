import { readEnv, type EnvName } from '@recourse/shared';

const NAMES = [
  'HEDERA_MIRROR_URL',
  'HEDERA_RPC_URL_1',
  'ARB_RPC_URL',
  'IPFS_GATEWAY_URL',
  'HCS_RECORDS_TOPIC_ID',
  'DEPLOYMENTS_DIR',
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
  'PRECHECK_URL',
  'WEB_ORIGIN',
] as const satisfies readonly EnvName[];

type Env = Record<string, string | undefined>;

export interface Config {
  mirrorUrl: string;
  hederaRpcUrls: string[];
  arbRpcUrl: string;
  ipfsGatewayUrl: string | null;
  recordsTopic: string;
  deploymentsDir: string;
  port: number;
  stateDir: string;
  pollMs: number;
  arbConfirmations: number;
  arbLogChunk: number;
  sourceTimeoutMs: number;
  viewCacheMs: number;
  lagWarnS: { hedera: number; arbitrum: number; hcs: number };
  ipfsRatePerMin: number;
  docketUrl: string;
  precheckUrl: string;
  webOrigin: string | null;
  /** Optional: `{id}` is replaced by the dispute id. */
  courtUrlTemplate: string | null;
}

export function loadConfig(env: Env = process.env): Config {
  const home = env.HOME ?? '';
  const v = readEnv(NAMES, {
    env,
    defaults: {
      HEDERA_RPC_URL_1: '',
      ARB_RPC_URL: '',
      IPFS_GATEWAY_URL: '',
      HCS_RECORDS_TOPIC_ID: '',
      DEPLOYMENTS_DIR: '',
      STATUS_API_PORT: '8787',
      STATUS_API_STATE_DIR: `${home}/.local/state/recourse/status-api`,
      POLL_MS: '5000',
      ARB_CONFIRMATIONS: '20',
      ARB_LOG_CHUNK: '1000',
      SOURCE_TIMEOUT_MS: '10000',
      VIEW_CACHE_MS: '5000',
      LAG_WARN_S_HEDERA: '60',
      LAG_WARN_S_ARB: '120',
      LAG_WARN_S_HCS: '60',
      IPFS_RATE_PER_MIN: '120',
      DOCKET_URL: 'http://127.0.0.1:8707',
      PRECHECK_URL: 'http://127.0.0.1:8705',
      WEB_ORIGIN: '',
    },
  });
  const hedera = [v.HEDERA_RPC_URL_1, env.HEDERA_RPC_URL_2 ?? ''].filter((s) => s !== '');
  return {
    mirrorUrl: v.HEDERA_MIRROR_URL.replace(/\/+$/, ''),
    hederaRpcUrls: hedera,
    arbRpcUrl: v.ARB_RPC_URL,
    ipfsGatewayUrl: v.IPFS_GATEWAY_URL === '' ? null : v.IPFS_GATEWAY_URL.replace(/\/+$/, ''),
    recordsTopic: v.HCS_RECORDS_TOPIC_ID,
    deploymentsDir: v.DEPLOYMENTS_DIR,
    port: Number(v.STATUS_API_PORT),
    stateDir: v.STATUS_API_STATE_DIR,
    pollMs: Number(v.POLL_MS),
    arbConfirmations: Number(v.ARB_CONFIRMATIONS),
    arbLogChunk: Number(v.ARB_LOG_CHUNK),
    sourceTimeoutMs: Number(v.SOURCE_TIMEOUT_MS),
    viewCacheMs: Number(v.VIEW_CACHE_MS),
    lagWarnS: { hedera: Number(v.LAG_WARN_S_HEDERA), arbitrum: Number(v.LAG_WARN_S_ARB), hcs: Number(v.LAG_WARN_S_HCS) },
    ipfsRatePerMin: Number(v.IPFS_RATE_PER_MIN),
    docketUrl: v.DOCKET_URL.replace(/\/+$/, ''),
    precheckUrl: v.PRECHECK_URL.replace(/\/+$/, ''),
    webOrigin: v.WEB_ORIGIN === '' ? null : v.WEB_ORIGIN,
    courtUrlTemplate: env.COURT_URL_TEMPLATE ?? 'https://v2-testnet.kleros.builders/#/cases/{id}/overview',
  };
}
