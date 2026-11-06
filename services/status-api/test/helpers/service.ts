import { PARAMS, parseParties, type Parties } from '@recourse/shared';
import { loadConfig, type Config } from '../../src/config.js';
import type { Deployments } from '../../src/deployments.js';
import type { FetchLike } from '../../src/http.js';
import { DocFetcher } from '../../src/ipfs.js';
import type { Reader } from '../../src/live.js';
import { StatusService } from '../../src/service.js';
import { Store } from '../../src/store.js';
import { createApp } from '../../src/app.js';
import { CASE, CLAIMS, PLATFORM, SHOP, SHOP2, TOPIC, VAULT, fakeReader } from './fixtures.js';
import { CIRCLE_VAULT_TOKEN, addressBook } from '@recourse/shared';

export function testParties(): Parties {
  const r = parseParties([
    { role: 'platform', evmAddress: PLATFORM, hederaAccountId: '0.0.1001', hcsWriters: ['0.0.1002'], displayName: 'Example Agent Co (sample)' },
    { role: 'agent', evmAddress: '0x' + '31'.repeat(20), hederaAccountId: '0.0.1002', hcsWriters: [], displayName: 'Example agent (sample)' },
    { role: 'shop', evmAddress: SHOP, hederaAccountId: '0.0.2001', hcsWriters: ['0.0.2001'], displayName: 'Example Shop (sample)' },
    { role: 'shop', evmAddress: SHOP2, hederaAccountId: '0.0.2002', hcsWriters: ['0.0.2002'], displayName: 'Second Example Shop (sample)' },
    { role: 'scheme', evmAddress: '0x' + '41'.repeat(20), hederaAccountId: '0.0.3001', hcsWriters: [], displayName: 'Docket writer (sample)' },
  ]);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

export function testDeployments(over: Partial<Deployments> = {}): Deployments {
  return {
    claims: CLAIMS,
    vault: VAULT,
    token: CIRCLE_VAULT_TOKEN,
    caseAddress: CASE,
    hederaChainId: 296,
    arbitrumChainId: 31338,
    arbitrumStartBlock: 0n,
    outside: {
      offRampHedera: addressBook.hedera.offRamp,
      offRampArb: addressBook.arbitrum.offRamp,
      klerosCore: addressBook.arbitrum.klerosCore,
      evidenceModule: addressBook.arbitrum.evidenceModule,
    },
    files: ['hedera.local.json'],
    local: true,
    ...over,
  };
}

export function testConfig(over: Partial<Config> = {}): Config {
  return { ...loadConfig({ HEDERA_RPC_URL_1: 'x', HCS_RECORDS_TOPIC_ID: TOPIC, HOME: '/tmp' }), ...over };
}

export interface Harness {
  store: Store;
  svc: StatusService;
  clock: { now: number };
  reader: Reader & { calls: string[] };
}

export function harness(opts: { store?: Store; reader?: Reader | null; now?: number; fetch?: FetchLike; parties?: Parties | null; cfg?: Partial<Config>; deployments?: Partial<Deployments> } = {}): Harness {
  const store = opts.store ?? new Store();
  const clock = { now: opts.now ?? 1_700_000_100 };
  const reader = (opts.reader ?? fakeReader()) as Reader & { calls: string[] };
  const cfg = testConfig({ viewCacheMs: 0, ...opts.cfg });
  const fetch: FetchLike = opts.fetch ?? (async () => ({ ok: false, status: 503, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }));
  const parties = opts.parties === undefined ? testParties() : opts.parties;
  const docs = new DocFetcher({ fetch, gatewayUrl: 'http://gateway.test', ratePerMin: 1000, timeoutMs: 1000 });
  const svc = new StatusService({
    store,
    cfg,
    deployments: testDeployments(opts.deployments),
    reader: opts.reader === null ? null : reader,
    parties: () => parties,
    docs,
    fetch,
    nowS: () => clock.now,
  });
  return { store, svc, clock, reader };
}

export async function serve(svc: StatusService): Promise<{ url: string; close: () => void }> {
  const app = createApp(svc);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

void PARAMS;
