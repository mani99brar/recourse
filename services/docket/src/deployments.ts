// Reads the deployment files and published ABIs. A file that is missing or has an unexpected
// shape yields null, so the docket starts and reports "no sources" instead of guessing.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { vaultTokenOf, type VaultToken } from '@recourse/shared';

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const addressAt = (o: Record<string, unknown> | null, name: string): `0x${string}` | undefined => {
  const c = (o?.contracts as Record<string, { address?: unknown }> | undefined)?.[name];
  return typeof c?.address === 'string' && ADDR.test(c.address) ? (c.address as `0x${string}`) : undefined;
};

export interface HederaDeployment {
  local: boolean;
  chainId: number;
  claims: `0x${string}`;
  vault: `0x${string}`;
  /** The vault's token, from the file's `usdc` object (none: Circle USDC). */
  token: VaultToken;
  /** Mirror-node cursor start, "secs.nanos". */
  startTimestamp: string | undefined;
  startBlock: bigint | undefined;
}

/**
 * `localFile` is a bare `*.local.json` name in the deployments directory; when set, that file is
 * the Hedera deployment and events are read over RPC instead of the mirror node. A `usdc` object
 * that does not validate throws: the token is never guessed.
 */
export function readHederaDeployment(dir: string, localFile?: string): HederaDeployment | null {
  const name = localFile ? basename(localFile) : 'hedera.json';
  if (localFile && !/\.local\.json$/.test(name)) throw new Error('HEDERA_LOCAL_FILE must be a bare *.local.json name');
  const j = readJson(join(dir, name));
  const claims = addressAt(j, 'claims');
  const vault = addressAt(j, 'vault');
  if (!j || !claims || !vault) return null;
  return {
    local: Boolean(localFile),
    chainId: Number(j.chainId),
    claims,
    vault,
    token: vaultTokenOf(j),
    startTimestamp: typeof j.startTimestamp === 'string' ? j.startTimestamp : undefined,
    startBlock: typeof j.startBlock === 'number' ? BigInt(j.startBlock) : undefined,
  };
}

export interface ArbitrumDeployment {
  case: `0x${string}`;
  startBlock: bigint;
}

export function readArbitrumDeployment(dir: string): ArbitrumDeployment | null {
  const j = readJson(join(dir, 'arbitrum.json'));
  const address = addressAt(j, 'case');
  if (!j || !address || typeof j.startBlock !== 'number') return null;
  return { case: address, startBlock: BigInt(j.startBlock) };
}

/** A published ABI array, or undefined when the file is absent or not an array. */
export function readAbi(dir: string, contract: string): readonly unknown[] | undefined {
  const p = join(dir, 'abi', `${contract}.json`);
  if (!existsSync(p)) return undefined;
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(v) ? v : Array.isArray(v?.abi) ? v.abi : undefined;
  } catch {
    return undefined;
  }
}
