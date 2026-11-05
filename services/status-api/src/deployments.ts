// Deployment files: where the contracts this repo deploys live. A `*.local.json` beside a file
// (written by local runs) wins over the testnet file and may replace the outside addresses.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addressBook, ARBITRUM_SEPOLIA_CHAIN_ID, HEDERA_TESTNET_CHAIN_ID } from '@recourse/shared';
import { getAddress, isAddress, type Address } from 'viem';

export interface Deployments {
  claims?: Address;
  vault?: Address;
  caseAddress?: Address;
  hederaChainId: number;
  arbitrumChainId: number;
  /** Mirror consensus timestamp to start reading Hedera logs from. */
  hederaStart?: string;
  arbitrumStartBlock: bigint;
  outside: { offRampHedera: Address; offRampArb: Address; klerosCore: Address; evidenceModule: Address };
  /** Names of the files that were read. */
  files: string[];
  local: boolean;
}

type Json = Record<string, unknown>;

function read(dir: string, name: string, override?: string): { json: Json; file: string } | null {
  for (const file of [...(override ? [override] : []), `${name}.local.json`, `${name}.json`]) {
    const p = join(dir, file);
    if (existsSync(p)) {
      try {
        const json = JSON.parse(readFileSync(p, 'utf8')) as Json;
        return { json, file };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function addr(v: unknown): Address | undefined {
  if (typeof v === 'string' && isAddress(v, { strict: false })) return getAddress(v);
  if (typeof v === 'object' && v !== null) return addr((v as Json).address);
  return undefined;
}

function dig(o: Json | undefined, ...paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = o;
    for (const part of p.split('.')) cur = typeof cur === 'object' && cur !== null ? (cur as Json)[part] : undefined;
    if (cur !== undefined) return cur;
  }
  return undefined;
}

export function loadDeployments(dir: string): Deployments {
  const h = dir ? read(dir, 'hedera', process.env.HEDERA_LOCAL_FILE) : null;
  const a = dir ? read(dir, 'arbitrum', process.env.ARBITRUM_LOCAL_FILE) : null;
  const files = [h?.file, a?.file].filter((f): f is string => f !== undefined);
  const out = dig(a?.json, 'outside') as Json | undefined;
  const pick = (k: string, fallback: Address) => addr(out?.[k]) ?? fallback;
  const startTs = dig(h?.json, 'startTimestamp');
  const startBlock = dig(a?.json, 'startBlock');
  return {
    claims: addr(dig(h?.json, 'contracts.claims.address')),
    vault: addr(dig(h?.json, 'contracts.vault.address')),
    caseAddress: addr(dig(a?.json, 'contracts.case.address')),
    hederaChainId: Number(dig(h?.json, 'chainId') ?? HEDERA_TESTNET_CHAIN_ID),
    arbitrumChainId: Number(dig(a?.json, 'chainId') ?? ARBITRUM_SEPOLIA_CHAIN_ID),
    ...(typeof startTs === 'string' || typeof startTs === 'number' ? { hederaStart: String(startTs) } : {}),
    arbitrumStartBlock: typeof startBlock === 'number' || typeof startBlock === 'string' ? BigInt(startBlock) : 0n,
    outside: {
      offRampHedera: pick('offRampHedera', addressBook.hedera.offRamp),
      offRampArb: pick('offRampArb', addressBook.arbitrum.offRamp),
      klerosCore: pick('klerosCore', addressBook.arbitrum.klerosCore),
      evidenceModule: pick('evidenceModule', addressBook.arbitrum.evidenceModule),
    },
    files,
    local: files.some((f) => f.endsWith('.local.json')),
  };
}
