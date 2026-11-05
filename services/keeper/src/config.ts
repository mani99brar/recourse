// Keeper configuration from the environment. Keys are never read here: the entry point loads the
// two signers from their keystore paths. Numbers are checked, and nothing a value holds is echoed
// in an error.

import { parseSendPauseWindows, readEnv, type SendPauseWindow } from '@recourse/shared';

export interface KeeperConfig {
  stateDir: string;
  port: number;
  pollMs: number;
  /** Arbitrum events are read this many blocks behind the head. */
  arbConfirmations: number;
  refileHoldS: number;
  windows: SendPauseWindow[];
  alertUrl?: string;
  precheckUrl?: string;
  ipfsGatewayUrl?: string;
  mirrorUrl: string;
  hederaRpcUrls: string[];
  arbRpcUrl: string;
  deploymentsDir: string;
  courtUrlTemplate: string;
}

type Env = Record<string, string | undefined>;

function whole(name: string, text: string, min: number, max: number): number {
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

export function loadKeeperConfig(env: Env = process.env): KeeperConfig {
  const e = readEnv(
    [
      'KEEPER_STATE_DIR',
      'KEEPER_PORT',
      'KEEPER_POLL_MS',
      'KEEPER_ARB_CONFIRMATIONS',
      'KEEPER_REFILE_HOLD_MIN',
      'SEND_PAUSE_WINDOWS',
      'ALERT_URL',
      'PRECHECK_URL',
      'IPFS_GATEWAY_URL',
      'HEDERA_MIRROR_URL',
      'HEDERA_RPC_URL_1',
      'HEDERA_RPC_URL_2',
      'ARB_RPC_URL',
      'DEPLOYMENTS_DIR',
      'COURT_URL_TEMPLATE',
    ],
    {
      env,
      defaults: {
        KEEPER_POLL_MS: '15000',
        KEEPER_ARB_CONFIRMATIONS: '20',
        KEEPER_REFILE_HOLD_MIN: '10',
        ALERT_URL: '',
        PRECHECK_URL: '',
        IPFS_GATEWAY_URL: '',
        HEDERA_RPC_URL_2: '',
      },
    },
  );
  const opt = (v: string) => (v === '' ? undefined : v);
  return {
    stateDir: e.KEEPER_STATE_DIR,
    port: whole('KEEPER_PORT', e.KEEPER_PORT, 1, 65535),
    pollMs: whole('KEEPER_POLL_MS', e.KEEPER_POLL_MS, 1000, 600_000),
    arbConfirmations: whole('KEEPER_ARB_CONFIRMATIONS', e.KEEPER_ARB_CONFIRMATIONS, 0, 10_000),
    refileHoldS: whole('KEEPER_REFILE_HOLD_MIN', e.KEEPER_REFILE_HOLD_MIN, 0, 1440) * 60,
    windows: parseSendPauseWindows(e.SEND_PAUSE_WINDOWS),
    ...(opt(e.ALERT_URL) ? { alertUrl: e.ALERT_URL } : {}),
    ...(opt(e.PRECHECK_URL) ? { precheckUrl: e.PRECHECK_URL } : {}),
    ...(opt(e.IPFS_GATEWAY_URL) ? { ipfsGatewayUrl: e.IPFS_GATEWAY_URL } : {}),
    mirrorUrl: e.HEDERA_MIRROR_URL,
    hederaRpcUrls: [e.HEDERA_RPC_URL_1, e.HEDERA_RPC_URL_2].filter((u) => u !== ''),
    arbRpcUrl: e.ARB_RPC_URL,
    deploymentsDir: e.DEPLOYMENTS_DIR,
    courtUrlTemplate: e.COURT_URL_TEMPLATE,
  };
}
