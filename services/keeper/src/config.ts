// Keeper configuration from the environment. Keys are never read here: the entry point loads the
// two signers from their keystore paths. Numbers are checked, and nothing a value holds is echoed
// in an error.

import { parseSendPauseWindows, readEnv, type SendPauseWindow } from '@recourse/shared';
import { parseUnits } from 'viem';
import type { FundingFloors } from './machine.js';

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
  /** Compact the journal once it reaches this many bytes. */
  compactAtBytes: number;
  /** Balances under which gas_low and link_low fire. */
  floors: FundingFloors;
}

/**
 * Funding floors in whole units, as the operator writes them. ops-hedera's is docs/keys.md's;
 * docs/keys.md has none for ops-arb, so 0.01 ETH; the claims contract's are 3 sends at the
 * measured CCIP quotes (2.2 HBAR or 0.013 LINK). Equal to DEFAULT_FLOORS in machine.ts.
 */
export const FLOOR_DEFAULTS = {
  KEEPER_FLOOR_OPS_HEDERA_HBAR: '10',
  KEEPER_FLOOR_OPS_ARB_ETH: '0.01',
  KEEPER_FLOOR_CLAIMS_FEE_HBAR: '6.6',
  KEEPER_FLOOR_CLAIMS_FEE_LINK: '0.04',
} as const;

/** A non-negative amount in whole units with at most 18 decimals, as 18-decimal base units. */
function amount(name: string, text: string, max: number): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(text)) throw new Error(`${name} must be a plain decimal amount`);
  if (Number(text) > max) throw new Error(`${name} must be at most ${max}`);
  return parseUnits(text, 18);
}

type Env = Record<string, string | undefined>;

function whole(name: string, text: string, min: number, max: number): number {
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

/**
 * A keeper-only knob read straight from the environment: the shared env list (readEnv) covers
 * the names every service shares, these belong to the keeper alone.
 */
function local(env: Env, name: string, fallback: string): string {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
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
    compactAtBytes: whole('KEEPER_COMPACT_MB', local(env, 'KEEPER_COMPACT_MB', '8'), 1, 64) * 1024 * 1024,
    floors: {
      opsHederaWeibar: amount('KEEPER_FLOOR_OPS_HEDERA_HBAR', local(env, 'KEEPER_FLOOR_OPS_HEDERA_HBAR', FLOOR_DEFAULTS.KEEPER_FLOOR_OPS_HEDERA_HBAR), 1_000_000),
      opsArbWei: amount('KEEPER_FLOOR_OPS_ARB_ETH', local(env, 'KEEPER_FLOOR_OPS_ARB_ETH', FLOOR_DEFAULTS.KEEPER_FLOOR_OPS_ARB_ETH), 1000),
      claimsFeeWeibar: amount('KEEPER_FLOOR_CLAIMS_FEE_HBAR', local(env, 'KEEPER_FLOOR_CLAIMS_FEE_HBAR', FLOOR_DEFAULTS.KEEPER_FLOOR_CLAIMS_FEE_HBAR), 1_000_000),
      claimsFeeLink: amount('KEEPER_FLOOR_CLAIMS_FEE_LINK', local(env, 'KEEPER_FLOOR_CLAIMS_FEE_LINK', FLOOR_DEFAULTS.KEEPER_FLOOR_CLAIMS_FEE_LINK), 1_000_000),
    },
  };
}
