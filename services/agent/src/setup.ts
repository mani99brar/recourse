// Builds the agent from its environment: the platform it buys for, the shop it finds through the
// shop's ERC-8004 registration, the records client, the payer and the journals.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http, type Address } from 'viem';
import { hederaTestnet } from 'viem/chains';
import { addressBook, erc8004IdentityAbi, partyByRole, priceAssetIdOf, priceAssetOf, type Parties } from '@recourse/shared';
import { loadSigner, readParties } from '@recourse/shared/node';
import {
  Journal,
  fetchRegistration,
  openRecordsClient,
  readH0Ids,
  x402EndpointOf,
  type Logger,
  type MirrorClient,
} from '@recourse/records';
import { Buyer, type AgentRow, type ShopTarget } from './buy.js';
import { loadAgentPayer } from './hedera-signer.js';
import { readLimits } from './limits.js';

type Env = Record<string, string | undefined>;

/** The agent's state folder when AGENT_STATE_DIR is not set: `services/agent/state` in the checkout. */
export const DEFAULT_AGENT_STATE_DIR = fileURLToPath(new URL('../state/', import.meta.url));

/** The agent's journals (orders, records, pay-once): AGENT_STATE_DIR when set, else the default. */
export function agentStateDir(env: Env = process.env): string {
  return env.AGENT_STATE_DIR ? resolve(env.AGENT_STATE_DIR) : DEFAULT_AGENT_STATE_DIR;
}

/** The order journal every agent command and the approvals service use. */
export function ordersJournalPath(env: Env = process.env): string {
  return join(agentStateDir(env), 'orders.jsonl');
}

/** The agent's records journal. */
export function recordsJournalPath(env: Env = process.env): string {
  return join(agentStateDir(env), 'records.jsonl');
}

export function partiesOrNull(env: Env): Parties | null {
  return env.PARTIES_FILE && existsSync(env.PARTIES_FILE) ? readParties(env) : null;
}

function rpcClient(env: Env) {
  if (!env.HEDERA_RPC_URL_1) throw new Error('HEDERA_RPC_URL_1 is not set');
  return createPublicClient({ chain: hederaTestnet, transport: http(env.HEDERA_RPC_URL_1, { timeout: 20_000 }) });
}

/** Thrown when the shop's registration names someone other than the party map's shop. Never falls back. */
export class RegistrationMismatchError extends Error {
  constructor(message: string) {
    super(`registration mismatch: ${message}`);
    this.name = 'RegistrationMismatchError';
  }
}

/**
 * What a fetched registration (and the identity token's owner) may name: the party map's shop only.
 * Whoever serves the agentURI controls the document, so the account paid, the asset and the owner
 * are checked against what this side already knows. Returns the differences, empty when it matches.
 */
export function registrationMismatches(
  found: { payTo: string; asset: string; owner: Address },
  expected: { payTo: string | undefined; asset: string; shopAddress: Address },
): string[] {
  const out: string[] = [];
  if (expected.payTo !== undefined && found.payTo !== expected.payTo) out.push(`payTo ${found.payTo}, the party map's shop is ${expected.payTo}`);
  if (found.asset !== expected.asset) out.push(`asset ${found.asset}, PRICE_ASSET is ${expected.asset}`);
  if (getAddress(found.owner) !== getAddress(expected.shopAddress)) out.push(`identity owner ${getAddress(found.owner)}, the party map's shop is ${getAddress(expected.shopAddress)}`);
  return out;
}

/**
 * Finds the shop: its agent id (party map, else the setup ids), the agentURI on the identity
 * registry, the registration document and its x402 service. With a party map, the registration's
 * payTo, asset and owner must be the party map's shop and the PRICE_ASSET id, or discovery stops
 * (RegistrationMismatchError, no fallback). SHOP_BASE_URL is used only when discovery fails
 * otherwise (an unreachable registry or agentURI, say), and the fallback is logged.
 */
export async function discoverShop(
  env: Env,
  log?: Logger,
  options: { client?: Pick<ReturnType<typeof rpcClient>, 'readContract'> } = {},
): Promise<ShopTarget> {
  const parties = partiesOrNull(env);
  const shopParty = parties ? partyByRole(parties, 'shop') : null;
  const agentId = shopParty?.agentId ?? readH0Ids()?.agents.shop?.agentId;
  let found: { endpoint: ReturnType<typeof x402EndpointOf>; owner: Address };
  try {
    if (!agentId) throw new Error('no shop agent id yet');
    const client = options.client ?? rpcClient(env);
    const identity = addressBook.hedera.erc8004Identity;
    const [uri, owner] = await Promise.all([
      client.readContract({ address: identity, abi: erc8004IdentityAbi, functionName: 'tokenURI', args: [BigInt(agentId)] }) as Promise<string>,
      client.readContract({ address: identity, abi: erc8004IdentityAbi, functionName: 'ownerOf', args: [BigInt(agentId)] }) as Promise<Address>,
    ]);
    const registration = await fetchRegistration(uri, { ipfsGatewayUrl: env.IPFS_GATEWAY_URL });
    const endpoint = x402EndpointOf(registration);
    if (endpoint.network !== 'hedera:testnet') throw new Error(`registration names network ${endpoint.network}`);
    found = { endpoint, owner };
  } catch (error) {
    const base = env.SHOP_BASE_URL;
    if (!base || !shopParty) throw error;
    if (shopParty.hederaAccountId === undefined) {
      throw new Error(`parties: shop has no hederaAccountId, so the SHOP_BASE_URL fallback cannot pay it (${error instanceof Error ? error.message.slice(0, 200) : String(error)})`);
    }
    log?.warn('shop_fallback', { reason: error instanceof Error ? error.message.slice(0, 200) : String(error), base });
    const apiBase = base.replace(/\/+$/, '').replace(/\/x402$/, '');
    return { x402Base: `${apiBase}/x402/`, apiBase, payTo: shopParty.hederaAccountId, shopAddress: shopParty.evmAddress, source: 'SHOP_BASE_URL' };
  }
  // Outside the fallback above: a registration naming another account is not a reason to try a
  // different route to the shop, it is a reason to stop.
  const { endpoint, owner } = found;
  if (shopParty) {
    const differs = registrationMismatches(
      { payTo: endpoint.payTo, asset: endpoint.asset, owner },
      { payTo: shopParty.hederaAccountId, asset: priceAssetIdOf(priceAssetOf(env)), shopAddress: shopParty.evmAddress },
    );
    if (differs.length > 0) {
      log?.error('shop_registration_mismatch', { agentId, differs: differs.join('; ') });
      throw new RegistrationMismatchError(differs.join('; '));
    }
  } else {
    log?.warn('shop_registration_unpinned', { agentId, note: 'no party map: payTo and owner are taken from the registration as they are' });
  }
  const x402Base = endpoint.baseUrl;
  log?.info('shop_discovered', { agentId, x402Base, payTo: endpoint.payTo, source: 'erc8004' });
  return { x402Base, apiBase: x402Base.replace(/\/x402\/?$/, ''), payTo: endpoint.payTo, shopAddress: getAddress(owner), source: `erc8004:${agentId}` };
}

export interface OpenedAgent {
  buyer: Buyer;
  shop: ShopTarget;
  mirror: MirrorClient;
  close(): void;
}

/** Builds the agent. `options.shop` names the shop directly (an in-process one) instead of discovering it. */
export async function openAgent(env: Env, log: Logger, options: { shop?: ShopTarget } = {}): Promise<OpenedAgent> {
  const parties = partiesOrNull(env);
  if (!parties) throw new Error('PARTIES_FILE is not set or missing; the agent needs the party map');
  const platform = partyByRole(parties, 'platform').evmAddress;
  const shop = options.shop ?? (await discoverShop(env, log));
  const records = openRecordsClient({ role: 'agent', journalPath: recordsJournalPath(env), env, log });
  const payer = loadAgentPayer(env);
  if (payer.accountId !== records.payer) throw new Error('agent payer and records payer differ');
  const journal = Journal.open<AgentRow>(ordersJournalPath(env));
  const buyer = new Buyer({
    platform,
    shop,
    records: records.client,
    pin: (bytes) => records.pins.pin(bytes),
    payer: payer.signer,
    agentAccount: loadSigner('AGENT_KEY_FILE', env),
    mirror: records.mirror,
    journal,
    limits: readLimits(env),
    // The same PRICE_ASSET rule as the shop's, so the agent expects the asset the 402 names.
    asset: priceAssetIdOf(priceAssetOf(env)),
    log,
  });
  return {
    buyer,
    shop,
    mirror: records.mirror,
    close: () => {
      journal.close();
      records.close();
    },
  };
}
