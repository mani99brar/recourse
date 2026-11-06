// Pre-check configuration: environment names, the deployments file and their parsing. Keys and the
// party map are not read here; the entry point loads them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, isAddress, type Address } from 'viem';
import { parseSendPauseWindows, readEnv, type SendPauseWindow } from '@recourse/shared';

type Env = Record<string, string | undefined>;

export interface PrecheckConfig {
  /** Hedera JSON-RPC URLs, first is primary; empty strings dropped. */
  rpcUrls: string[];
  mirrorUrl: string;
  gatewayUrl: string;
  /** Records topic as configured, `shard.realm.num`. */
  topicId: string;
  /** The N of the topic id. */
  topicNum: bigint;
  alertUrl: string | undefined;
  stateDir: string;
  port: number;
  quietS: number;
  pauseWindows: SendPauseWindow[];
  claimsAddress: Address;
  /** Consensus timestamp the claims log cursor starts from when none is saved. */
  startTimestamp: string;
  /** Milliseconds between ticks. */
  tickMs: number;
  /** Seconds after a filing from which a record document that still cannot be read is rejected; default DOC_WAIT_S (one hour). */
  docWaitS?: number;
}

export interface Deployment {
  claimsAddress: Address;
  startTimestamp: string;
}

const TOPIC = /^\d+\.\d+\.(\d+)$/;
const LOCAL_FILE = /^[A-Za-z0-9_-]+\.local\.json$/;
const TIMESTAMP = /^\d+(\.\d{1,9})?$/;

export function topicNumOf(topicId: string): bigint {
  const m = TOPIC.exec(topicId);
  if (m === null) throw new Error('HCS_RECORDS_TOPIC_ID: expected shard.realm.num');
  return BigInt(m[1]!);
}

function field(json: unknown, path: string[]): unknown {
  let cur = json;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Reads the claims address and start timestamp out of a parsed deployments file. */
export function parseDeployment(json: unknown): Deployment {
  const address = field(json, ['contracts', 'claims', 'address']);
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    throw new Error('deployments: contracts.claims.address is missing or not an address');
  }
  const ts = field(json, ['startTimestamp']);
  if (typeof ts !== 'string' || !TIMESTAMP.test(ts)) {
    throw new Error('deployments: startTimestamp must be a decimal string "secs.nanos"');
  }
  return { claimsAddress: getAddress(address), startTimestamp: ts };
}

/**
 * Reads `hedera.json` from DEPLOYMENTS_DIR, or the file `fileName` in it: a bare name ending
 * `.local.json`, never a path.
 */
export function readDeployment(dir: string, fileName = 'hedera.json'): Deployment {
  if (fileName !== 'hedera.json' && !LOCAL_FILE.test(fileName)) {
    throw new Error('deployments file must be hedera.json or a bare *.local.json name');
  }
  let text: string;
  try {
    text = readFileSync(join(dir, fileName), 'utf8');
  } catch {
    throw new Error(`deployments: could not read ${fileName} in DEPLOYMENTS_DIR`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`deployments: ${fileName} is not valid JSON`);
  }
  return parseDeployment(json);
}

function int(name: string, text: string, min: number, max: number): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: expected an integer from ${min} to ${max}`);
  return n;
}

export function loadConfig(env: Env = process.env, options: { deploymentsFile?: string } = {}): PrecheckConfig {
  const e = readEnv(
    [
      'HEDERA_RPC_URL_1',
      'HEDERA_RPC_URL_2',
      'HEDERA_MIRROR_URL',
      'IPFS_GATEWAY_URL',
      'HCS_RECORDS_TOPIC_ID',
      'ALERT_URL',
      'PRECHECK_STATE_DIR',
      'PRECHECK_PORT',
      'PRECHECK_QUIET_S',
      'SEND_PAUSE_WINDOWS',
      'DEPLOYMENTS_DIR',
    ],
    { env, defaults: { HEDERA_RPC_URL_2: '', ALERT_URL: '', IPFS_GATEWAY_URL: '' } },
  );
  const deployment = readDeployment(e.DEPLOYMENTS_DIR, options.deploymentsFile);
  return {
    rpcUrls: [e.HEDERA_RPC_URL_1, e.HEDERA_RPC_URL_2].filter((u) => u !== ''),
    mirrorUrl: e.HEDERA_MIRROR_URL,
    gatewayUrl: e.IPFS_GATEWAY_URL,
    topicId: e.HCS_RECORDS_TOPIC_ID,
    topicNum: topicNumOf(e.HCS_RECORDS_TOPIC_ID),
    alertUrl: e.ALERT_URL === '' ? undefined : e.ALERT_URL,
    stateDir: e.PRECHECK_STATE_DIR,
    port: int('PRECHECK_PORT', e.PRECHECK_PORT, 1, 65535),
    quietS: int('PRECHECK_QUIET_S', e.PRECHECK_QUIET_S, 0, 86_400),
    pauseWindows: parseSendPauseWindows(e.SEND_PAUSE_WINDOWS),
    claimsAddress: deployment.claimsAddress,
    startTimestamp: deployment.startTimestamp,
    tickMs: 15_000,
  };
}
