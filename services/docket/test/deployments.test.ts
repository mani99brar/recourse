import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAbi, readArbitrumDeployment, readHederaDeployment } from '../src/deployments.js';
import { RpcLogSource } from '../src/sources.js';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';

function dir(files: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'deploy-'));
  mkdirSync(join(d, 'abi'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), JSON.stringify(body));
  return d;
}

describe('deployment files', () => {
  it('reads the Hedera shape and the local variant', () => {
    const body = { chainId: 296, contracts: { claims: { address: A, id: '0.0.1' }, vault: { address: B, id: '0.0.2' } }, startTimestamp: '1793901919.123456789', startBlock: 12 };
    const d = dir({ 'hedera.json': body, 'x.local.json': { ...body, chainId: 31337 } });
    expect(readHederaDeployment(d)).toMatchObject({ local: false, claims: A, vault: B, startTimestamp: '1793901919.123456789', startBlock: 12n });
    expect(readHederaDeployment(d, 'x.local.json')).toMatchObject({ local: true, chainId: 31337 });
    expect(() => readHederaDeployment(d, '../hedera.json')).not.toThrow(); // path stripped to a bare name, then refused
  });

  it('refuses a local file that is not a bare *.local.json name', () => {
    expect(() => readHederaDeployment(dir({}), 'hedera.json')).toThrow(/local\.json/);
  });

  it('returns null for a missing or odd file, never a guess', () => {
    const d = dir({ 'hedera.json': { contracts: { claims: { address: 'nope' } } } });
    expect(readHederaDeployment(d)).toBeNull();
    expect(readHederaDeployment(dir({}))).toBeNull();
    expect(readArbitrumDeployment(dir({}))).toBeNull();
  });

  it('reads the Arbitrum shape and ABI arrays', () => {
    const d = dir({ 'arbitrum.json': { contracts: { case: { address: A } }, startBlock: 99 }, 'abi/RecourseCase.json': [{ type: 'event', name: 'CaseOpened', inputs: [] }] });
    expect(readArbitrumDeployment(d)).toEqual({ case: A, startBlock: 99n });
    expect(readAbi(d, 'RecourseCase')).toHaveLength(1);
    expect(readAbi(d, 'Missing')).toBeUndefined();
  });
});

describe('rpc log source', () => {
  it('stamps events with block time and reads from the start block', async () => {
    const seen: bigint[] = [];
    const reader = {
      getBlockNumber: async () => 5n,
      getLogs: async ({ fromBlock }: { fromBlock: bigint }) => (seen.push(fromBlock), []),
      getBlockTimestamp: async () => 1,
    };
    const src = new RpcLogSource(reader, { chain: 'hedera', name: 'hedera-claims', address: A, startBlock: 3n });
    expect((await src.poll(undefined)).cursor).toBe('5');
    expect(seen).toEqual([3n]);
  });
});
