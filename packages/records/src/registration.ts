// ERC-8004 registration documents for the shop and the agent company, and the reader the agent uses
// to find the shop's x402 endpoint from its agentURI. A document may be served over HTTPS, pinned
// to IPFS, or carried inline as a `data:application/json;base64,` URI.

import { addressBook } from '@recourse/shared';

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
export const X402_SERVICE = 'x402';

export interface RegistrationService {
  name: string;
  endpoint: string;
  [key: string]: unknown;
}

export interface RegistrationDoc {
  type: string;
  name: string;
  description: string;
  services: RegistrationService[];
  x402Support?: boolean;
  active?: boolean;
  registrations?: { agentId: string; agentRegistry: string }[];
  /** What kind of shop or agent company this is, for people browsing the registry (the cast page reads it). */
  recourse?: RegistrationType;
}

export interface RegistrationType {
  role: 'shop' | 'platform';
  kind: string;
  label: string;
  summary: string;
}

export interface X402Endpoint {
  /** Base URL of the shop's paid routes, ending in `/x402/`. */
  baseUrl: string;
  network: string;
  payTo: string;
  asset: string;
}

/** CAIP-10-style id of the Identity registry on Hedera testnet. */
export function identityRegistryRef(): string {
  return `eip155:${addressBook.hedera.chainId}:${addressBook.hedera.erc8004Identity}`;
}

export function shopRegistration(input: {
  name: string;
  x402BaseUrl: string;
  payTo: string;
  asset: string;
  network: string;
  agentId?: string;
  recourse?: RegistrationType;
}): RegistrationDoc {
  const doc: RegistrationDoc = {
    type: REGISTRATION_TYPE,
    name: input.name,
    description: 'Shop that sells over x402 on Hedera and records each order on the Recourse HCS topic.',
    services: [
      {
        name: X402_SERVICE,
        endpoint: withTrailingSlash(input.x402BaseUrl),
        network: input.network,
        payTo: input.payTo,
        asset: input.asset,
      },
    ],
    x402Support: true,
    active: true,
  };
  if (input.agentId) doc.registrations = [{ agentId: input.agentId, agentRegistry: identityRegistryRef() }];
  if (input.recourse) doc.recourse = input.recourse;
  return doc;
}

export function agentCompanyRegistration(input: { name: string; agentId?: string }): RegistrationDoc {
  const doc: RegistrationDoc = {
    type: REGISTRATION_TYPE,
    name: input.name,
    description:
      'Shopping agent that pays over x402 on Hedera, records what it was asked, shown and approved, and posts a deposit that covers its mistakes.',
    services: [],
    x402Support: true,
    active: true,
  };
  if (input.agentId) doc.registrations = [{ agentId: input.agentId, agentRegistry: identityRegistryRef() }];
  return doc;
}

export function toDataUri(doc: RegistrationDoc): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(doc), 'utf8').toString('base64')}`;
}

/** Reads the x402 service entry; throws with a reason when the document has none or it is malformed. */
export function x402EndpointOf(doc: unknown): X402Endpoint {
  if (typeof doc !== 'object' || doc === null) throw new Error('registration: not an object');
  const services = (doc as { services?: unknown; endpoints?: unknown }).services ?? (doc as { endpoints?: unknown }).endpoints;
  if (!Array.isArray(services)) throw new Error('registration: no services list');
  const entry = services.find(
    (s): s is Record<string, unknown> => typeof s === 'object' && s !== null && (s as { name?: unknown }).name === X402_SERVICE,
  );
  if (!entry) throw new Error('registration: no x402 service');
  const { endpoint, network, payTo, asset } = entry;
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) throw new Error('registration: x402 endpoint is not a URL');
  if (typeof network !== 'string' || typeof payTo !== 'string' || typeof asset !== 'string') {
    throw new Error('registration: x402 service lacks network, payTo or asset');
  }
  return { baseUrl: withTrailingSlash(endpoint), network, payTo, asset };
}

/** Fetches and parses a registration document from an agentURI (`data:`, `https:`, `http:` or `ipfs://`). */
export async function fetchRegistration(
  agentUri: string,
  options: { ipfsGatewayUrl?: string; fetchImpl?: (url: string, init?: RequestInit) => Promise<Response> } = {},
): Promise<unknown> {
  const doFetch = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const dataMatch = /^data:application\/json(;base64)?,(.*)$/s.exec(agentUri);
  if (dataMatch) {
    const body = dataMatch[1] ? Buffer.from(dataMatch[2]!, 'base64').toString('utf8') : decodeURIComponent(dataMatch[2]!);
    return JSON.parse(body);
  }
  let url = agentUri;
  if (agentUri.startsWith('ipfs://')) {
    if (!options.ipfsGatewayUrl) throw new Error('registration: ipfs:// agentURI but IPFS_GATEWAY_URL is not set');
    url = `${options.ipfsGatewayUrl.replace(/\/+$/, '')}/ipfs/${agentUri.slice('ipfs://'.length)}`;
  }
  if (!/^https?:\/\//.test(url)) throw new Error('registration: unsupported agentURI scheme');
  const res = await doFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`registration: ${res.status} fetching agentURI`);
  const text = await res.text();
  if (text.length > 64 * 1024) throw new Error('registration: document too large');
  return JSON.parse(text);
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
