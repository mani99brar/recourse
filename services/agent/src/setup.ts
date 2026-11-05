// Builds the agent from its environment: the platform it buys for, the shop it finds through the
// shop's ERC-8004 registration, the records client, the payer and the journals.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http, type Address } from 'viem';
import { hederaTestnet } from 'viem/chains';
import { addressBook, erc8004IdentityAbi, partyByRole, type Parties } from '@recourse/shared';
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

export const AGENT_STATE_DIR = fileURLToPath(new URL('../state/', import.meta.url));
export const ORDERS_JOURNAL = join(AGENT_STATE_DIR, 'orders.jsonl');
export const RECORDS_JOURNAL = join(AGENT_STATE_DIR, 'records.jsonl');

export function partiesOrNull(env: Env): Parties | null {
  return env.PARTIES_FILE && existsSync(env.PARTIES_FILE) ? readParties(env) : null;
}

function rpcClient(env: Env) {
  if (!env.HEDERA_RPC_URL_1) throw new Error('HEDERA_RPC_URL_1 is not set');
  return createPublicClient({ chain: hederaTestnet, transport: http(env.HEDERA_RPC_URL_1, { timeout: 20_000 }) });
}

/**
 * Finds the shop: its agent id (party map, else the setup ids), the agentURI on the identity
 * registry, the registration document and its x402 service. SHOP_BASE_URL is used only when that
 * fails, and the fallback is logged.
 */
export async function discoverShop(env: Env, log?: Logger): Promise<ShopTarget> {
  const parties = partiesOrNull(env);
  const shopParty = parties ? partyByRole(parties, 'shop') : null;
  const agentId = shopParty?.agentId ?? readH0Ids()?.agents.shop?.agentId;
  try {
    if (!agentId) throw new Error('no shop agent id yet');
    const client = rpcClient(env);
    const identity = addressBook.hedera.erc8004Identity;
    const [uri, owner] = await Promise.all([
      client.readContract({ address: identity, abi: erc8004IdentityAbi, functionName: 'tokenURI', args: [BigInt(agentId)] }) as Promise<string>,
      client.readContract({ address: identity, abi: erc8004IdentityAbi, functionName: 'ownerOf', args: [BigInt(agentId)] }) as Promise<Address>,
    ]);
    const registration = await fetchRegistration(uri, { ipfsGatewayUrl: env.IPFS_GATEWAY_URL });
    const endpoint = x402EndpointOf(registration);
    if (endpoint.network !== 'hedera:testnet') throw new Error(`registration names network ${endpoint.network}`);
    const x402Base = endpoint.baseUrl;
    log?.info('shop_discovered', { agentId, x402Base, payTo: endpoint.payTo, source: 'erc8004' });
    return { x402Base, apiBase: x402Base.replace(/\/x402\/?$/, ''), payTo: endpoint.payTo, shopAddress: getAddress(owner), source: `erc8004:${agentId}` };
  } catch (error) {
    const base = env.SHOP_BASE_URL;
    if (!base || !shopParty?.hederaAccountId) throw error;
    log?.warn('shop_fallback', { reason: error instanceof Error ? error.message.slice(0, 200) : String(error), base });
    const apiBase = base.replace(/\/+$/, '').replace(/\/x402$/, '');
    return { x402Base: `${apiBase}/x402/`, apiBase, payTo: shopParty.hederaAccountId, shopAddress: shopParty.evmAddress, source: 'SHOP_BASE_URL' };
  }
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
  const records = openRecordsClient({ role: 'agent', journalPath: RECORDS_JOURNAL, env, log });
  const payer = loadAgentPayer(env);
  if (payer.accountId !== records.payer) throw new Error('agent payer and records payer differ');
  const journal = Journal.open<AgentRow>(ORDERS_JOURNAL);
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
    asset: (env.PRICE_ASSET ?? 'usdc').toLowerCase() === 'hbar' ? '0.0.0' : addressBook.hedera.usdc.tokenId,
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
