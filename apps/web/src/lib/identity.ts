// An ERC-8004 registration built in the browser: the registration document for a shop or an agent
// company, carried inline as a data: URI, the unsigned register call for the person's own wallet, and
// the read-back of the identity it made. Anyone may register on the registry; nothing here signs.
// The document shape follows packages/records/src/registration.ts (that package is not a web
// dependency, and its encoder uses Node's Buffer).
import { addressBook, erc8004IdentityAbi } from '@recourse/shared';
import { createPublicClient, custom, encodeFunctionData, parseEventLogs, type Address, type EIP1193Provider, type Hash } from 'viem';
import type { UnsignedTx } from './actions.js';
import { CHAINS, HEDERA_CHAIN_ID } from './chains.js';

export const REGISTRY: Address = addressBook.hedera.erc8004Identity;
/** The contract label every registry call shows, in the preview and in the check of its data. */
export const REGISTRY_LABEL = 'ERC-8004 identity registry';
export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export interface RegistrationType {
  role: 'shop' | 'platform';
  kind: string;
  label: string;
  summary: string;
}

export interface RegistrationDoc {
  type: string;
  name: string;
  description: string;
  services: { name: string; endpoint: string; [key: string]: unknown }[];
  x402Support?: boolean;
  active?: boolean;
  registrations?: { agentId: string; agentRegistry: string }[];
  /** What kind of shop or agent company this is, for people browsing the registry (the cast page reads it). */
  recourse?: RegistrationType;
}

export interface RegistrationInput {
  /** 'shop', or 'platform' for an agent company (the vault's word for it). */
  role: 'shop' | 'platform';
  name: string;
  /** Defaults to the sentence the demo cast's own documents carry for the role. */
  description?: string;
  kind: string;
  label: string;
  summary: string;
  /** A shop's paid x402 routes, when it has them: the agent finds the shop through this entry. */
  x402?: { baseUrl: string; network: string; payTo: string; asset: string };
}

const DESCRIPTIONS: Record<RegistrationInput['role'], string> = {
  shop: 'Shop that sells over x402 on Hedera and records each order on the Recourse HCS topic.',
  platform: 'Shopping agent that pays over x402 on Hedera, records what it was asked, shown and approved, and posts a deposit that covers its mistakes.',
};

/** The registration document for a shop or an agent company, in the shape the cast page and the agent read. */
export function registrationDoc(input: RegistrationInput): RegistrationDoc {
  const services: RegistrationDoc['services'] = [];
  if (input.x402) {
    const endpoint = input.x402.baseUrl.endsWith('/') ? input.x402.baseUrl : `${input.x402.baseUrl}/`;
    services.push({ name: 'x402', endpoint, network: input.x402.network, payTo: input.x402.payTo, asset: input.x402.asset });
  }
  return {
    type: REGISTRATION_TYPE,
    name: input.name.trim(),
    description: input.description?.trim() || DESCRIPTIONS[input.role],
    services,
    x402Support: true,
    active: true,
    recourse: { role: input.role, kind: input.kind, label: input.label, summary: input.summary },
  };
}

/** The URI is stored on chain in full, so the page keeps it small: at most this many bytes. */
export const MAX_URI_BYTES = 2048;

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The document inline, as `data:application/json;base64,…` (UTF-8 JSON). */
export function dataUri(doc: RegistrationDoc): string {
  return `data:application/json;base64,${base64(new TextEncoder().encode(JSON.stringify(doc)))}`;
}

/** The document a data: URI carries, or null when it is not one this page reads. */
export function docFromUri(uri: string): RegistrationDoc | null {
  const m = /^data:application\/json;base64,([A-Za-z0-9+/=]*)$/.exec(uri);
  if (!m) return null;
  try {
    const bin = atob(m[1]!);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as RegistrationDoc;
  } catch {
    return null;
  }
}

/** The URI's length in bytes, and why it is too long (null when it fits). */
export function uriSize(uri: string): { bytes: number; problem: string | null } {
  const bytes = new TextEncoder().encode(uri).length;
  const problem = bytes > MAX_URI_BYTES ? `The registration is ${bytes.toLocaleString('en-US')} bytes; it is stored on chain, so this page keeps it to ${MAX_URI_BYTES.toLocaleString('en-US')}. Shorten the summary or the description.` : null;
  return { bytes, problem };
}

/**
 * The unsigned register(agentURI) call. Gas is left at 0 here: the signing panel (LocalFlow)
 * estimates it through the wallet before the preview, and marks it simulated only then.
 */
export function buildRegister(agentURI: string): UnsignedTx {
  const size = uriSize(agentURI);
  if (size.problem) throw new RangeError(size.problem);
  return {
    chainId: HEDERA_CHAIN_ID,
    to: REGISTRY,
    data: encodeFunctionData({ abi: erc8004IdentityAbi, functionName: 'register', args: [agentURI] }),
    value: '0',
    gas: '0',
    gasPrice: '0',
    description: `Register a new ERC-8004 identity whose registration is stored inline (${size.bytes.toLocaleString('en-US')} bytes); your account owns it.`,
    call: { contract: REGISTRY_LABEL, function: 'register', args: { agentURI } },
    simulated: false,
  };
}

export interface Registered {
  /** The new identity's id, decimal text. */
  agentId: string;
  /** ownerOf(agentId), read after the receipt. */
  owner: Address;
  /** tokenURI(agentId), read after the receipt. */
  agentURI: string;
  /** The registry now gives the owner and URI the Registered event named. */
  matches: boolean;
}

/**
 * The identity a mined register made: the agent id from the receipt's Registered event (a return
 * value is not in a receipt), then its owner and URI read from the registry, through the wallet's
 * connection to Hedera testnet. Null when the receipt has no Registered event from the registry.
 */
export async function readBack(provider: EIP1193Provider, txHash: Hash): Promise<Registered | null> {
  const client = createPublicClient({ chain: CHAINS[HEDERA_CHAIN_ID], transport: custom(provider, { retryCount: 1 }) });
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const logs = parseEventLogs({ abi: erc8004IdentityAbi, eventName: 'Registered', logs: receipt.logs }).filter((l) => l.address.toLowerCase() === REGISTRY.toLowerCase());
  const ev = logs[0];
  if (!ev) return null;
  const id = ev.args.agentId;
  const [owner, agentURI] = await Promise.all([
    client.readContract({ address: REGISTRY, abi: erc8004IdentityAbi, functionName: 'ownerOf', args: [id] }),
    client.readContract({ address: REGISTRY, abi: erc8004IdentityAbi, functionName: 'tokenURI', args: [id] }),
  ]);
  return { agentId: id.toString(), owner, agentURI, matches: owner.toLowerCase() === ev.args.owner.toLowerCase() && agentURI === ev.args.agentURI };
}
