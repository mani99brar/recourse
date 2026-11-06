// Reads the two deployment files the keeper runs against. Testnet runs read `hedera.json` and
// `arbitrum.json` from DEPLOYMENTS_DIR; local runs name `*.local.json` files there instead, whose
// `outside` block replaces the third-party addresses (OffRamps, arbitrator, evidence module). The vault's
// token comes from the Hedera file's `usdc` object (none: Circle USDC); a bad one stops startup.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addressBook, vaultTokenOf, type VaultToken } from '@recourse/shared';
import { getAddress, isAddress, type Address } from 'viem';

const LOCAL_FILE = /^[A-Za-z0-9_.-]+\.local\.json$/;

export interface HederaDeployment {
  file: string;
  local: boolean;
  chainId: number;
  claims: Address;
  /** Hedera contract id "0.0.N"; null in a local file (no mirror node there). */
  claimsId: string | null;
  vault: Address;
  /** The token the vault holds, named in operator alerts about vault amounts. */
  token: VaultToken;
  /** Consensus timestamp "secs.nanos" of the first deploy transaction: the mirror cursor start. */
  startTimestamp: string;
  startBlock: number;
  /** OffRamp on Hedera that executes Arbitrum -> Hedera messages. */
  offRamp: Address;
  /** Local RPC URL, when the file names one. */
  rpcUrl?: string;
}

export interface ArbitrumDeployment {
  file: string;
  local: boolean;
  chainId: number;
  case: Address;
  startBlock: number;
  /** OffRamp on Arbitrum that executes Hedera -> Arbitrum messages. */
  offRamp: Address;
  /** OffRamp on the Hedera side, from a local file's `outside` block. */
  offRampHedera?: Address;
  klerosCore: Address;
  evidenceModule: Address;
  /** Absent locally: the mock arbitrator has neither. */
  disputeKit?: Address;
  sortitionModule?: Address;
  rpcUrl?: string;
}

function checkName(name: string, testnet: string): void {
  if (name !== testnet && !LOCAL_FILE.test(name)) throw new Error(`deployments: ${name} must be ${testnet} or a bare *.local.json name`);
}

function readJson(dir: string, name: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(join(dir, name), 'utf8');
  } catch {
    throw new Error(`deployments: cannot read ${name} in DEPLOYMENTS_DIR`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`deployments: ${name} is not valid JSON`);
  }
}

function addr(v: unknown, what: string): Address {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new Error(`deployments: ${what} is not an address`);
  return getAddress(v);
}

function int(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`deployments: ${what} is not a whole number`);
  return v;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export function readHederaDeployment(dir: string, name = 'hedera.json', outsideFrom?: ArbitrumDeployment): HederaDeployment {
  checkName(name, 'hedera.json');
  const j = readJson(dir, name);
  const local = name !== 'hedera.json';
  const contracts = obj(j.contracts);
  const claims = obj(contracts.claims);
  const vault = obj(contracts.vault);
  const id = claims.id;
  if (id !== null && (typeof id !== 'string' || !/^0\.0\.\d+$/.test(id))) throw new Error('deployments: contracts.claims.id must be "0.0.N" or null');
  if (!local && id === null) throw new Error('deployments: contracts.claims.id is required on testnet');
  if (typeof j.startTimestamp !== 'string' || !/^\d+\.\d{9}$/.test(j.startTimestamp)) {
    throw new Error('deployments: startTimestamp must be a decimal string "secs.nanos"');
  }
  const offRamp = local ? outsideFrom?.offRampHedera : addressBook.hedera.offRamp;
  if (offRamp === undefined) throw new Error('deployments: a local Hedera file needs the arbitrum local file for its OffRamp (outside.offRampHedera)');
  return {
    file: name,
    local,
    chainId: int(j.chainId, 'chainId'),
    claims: addr(claims.address, 'contracts.claims.address'),
    claimsId: id as string | null,
    vault: addr(vault.address, 'contracts.vault.address'),
    token: vaultTokenOf(j),
    startTimestamp: j.startTimestamp,
    startBlock: int(j.startBlock, 'startBlock'),
    offRamp,
    ...(typeof j.rpcUrl === 'string' ? { rpcUrl: j.rpcUrl } : {}),
  };
}

export function readArbitrumDeployment(dir: string, name = 'arbitrum.json'): ArbitrumDeployment {
  checkName(name, 'arbitrum.json');
  const j = readJson(dir, name);
  const local = name !== 'arbitrum.json';
  const book = addressBook.arbitrum;
  const kase = addr(obj(obj(j.contracts).case).address, 'contracts.case.address');
  const base = { file: name, local, chainId: int(j.chainId, 'chainId'), case: kase, startBlock: int(j.startBlock, 'startBlock') };
  const rpc = typeof j.rpcUrl === 'string' ? { rpcUrl: j.rpcUrl } : {};
  if (!local) {
    return {
      ...base,
      offRamp: book.offRamp,
      klerosCore: book.klerosCore,
      evidenceModule: book.evidenceModule,
      disputeKit: book.disputeKitClassic,
      sortitionModule: book.sortitionModule,
      ...rpc,
    };
  }
  const outside = obj(j.outside);
  return {
    ...base,
    offRamp: addr(outside.offRampArb, 'outside.offRampArb'),
    offRampHedera: addr(outside.offRampHedera, 'outside.offRampHedera'),
    klerosCore: addr(outside.klerosCore, 'outside.klerosCore'),
    evidenceModule: addr(outside.evidenceModule, 'outside.evidenceModule'),
    ...rpc,
  };
}
