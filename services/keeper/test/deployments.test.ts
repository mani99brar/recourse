import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveChains } from '../src/adapter.js';
import { readArbitrumDeployment, readHederaDeployment } from '../src/deployments.js';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const MOCK = '0x1111111111111111111111111111111111111111';
const body = { chainId: 296, contracts: { claims: { address: A, id: '0.0.1' }, vault: { address: B, id: '0.0.2' } }, startTimestamp: '1793901919.123456789', startBlock: 12 };

function dir(files: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'keeper-deploy-'));
  for (const [name, b] of Object.entries(files)) writeFileSync(join(d, name), JSON.stringify(b));
  return d;
}

describe('hedera deployment, vault token', () => {
  it('is Circle USDC for a record with no usdc key', () => {
    expect(readHederaDeployment(dir({ 'hedera.json': body })).token).toMatchObject({ mode: 'circle', symbol: 'USDC', tokenId: '0.0.429274' });
  });

  it('reads circle and mock mode from the record', () => {
    const circle = { mode: 'circle', address: '0x0000000000000000000000000000000000068cDa', decimals: 6, tokenId: '0.0.429274' };
    expect(readHederaDeployment(dir({ 'hedera.json': { ...body, usdc: circle } })).token.mode).toBe('circle');
    const mock = { mode: 'mock', address: MOCK, decimals: 6, tokenId: null };
    expect(readHederaDeployment(dir({ 'hedera.json': { ...body, usdc: mock } })).token).toMatchObject({ mode: 'mock', address: MOCK, symbol: 'mUSDC', label: 'mUSDC (testnet mock)' });
  });

  it('stops on a usdc object that does not validate', () => {
    const atFacade = { mode: 'mock', address: '0x0000000000000000000000000000000000068cDa', decimals: 6, tokenId: null };
    expect(() => readHederaDeployment(dir({ 'hedera.json': { ...body, usdc: atFacade } }))).toThrow("cannot name Circle's facade");
    expect(() => readHederaDeployment(dir({ 'hedera.json': { ...body, usdc: { mode: 'hts' } } }))).toThrow('mode must be circle or mock');
  });
});

describe('arbitrum deployment, dispute views', () => {
  const arbBody = { chainId: 421614, contracts: { case: { address: A } }, startBlock: 7 };
  const chainsFor = (arb: ReturnType<typeof readArbitrumDeployment>) =>
    new LiveChains({
      hedera: { client: {} as never, claims: A, vault: B, offRamp: B, events: {} as never, sender: {} as never },
      arbitrum: {
        client: {} as never,
        chainId: arb.chainId,
        case: arb.case,
        klerosCore: arb.klerosCore,
        evidenceModule: arb.evidenceModule,
        offRamp: arb.offRamp,
        reader: {} as never,
        sender: {} as never,
        ...(arb.disputeKit ? { disputeKit: arb.disputeKit } : {}),
        ...(arb.sortitionModule ? { sortitionModule: arb.sortitionModule } : {}),
      },
    });

  it('testnet (KlerosCore) has them, so a failed dispute read holds expiry back', () => {
    expect(chainsFor(readArbitrumDeployment(dir({ 'arbitrum.json': arbBody }))).disputeViews).toBe(true);
  });

  it('a local file (the mock arbitrator) has none', () => {
    const outside = { offRampArb: A, offRampHedera: B, klerosCore: MOCK, evidenceModule: B };
    expect(chainsFor(readArbitrumDeployment(dir({ 'arbitrum.local.json': { ...arbBody, outside } }), 'arbitrum.local.json')).disputeViews).toBe(false);
  });
});
