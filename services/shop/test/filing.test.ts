import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { claimIdOf, orderIdOf, type RecordRefs } from '@recourse/shared';
import { Journal } from '@recourse/records';
import type { ChainClients } from '../src/chain.js';
import { ClaimFiler, FilingError, type FilingJournalRow } from '../src/filing.js';

const CLAIMS = getAddress('0x6088dd5B97C7b77F00a5357cCc4f599deA412c5C');
const VAULT = getAddress('0xd7f11FA06A97a45a6Af03c71d7eB3219C1a703B8');
const MOCK = getAddress('0x1111111111111111111111111111111111111111');
const FACADE = getAddress('0x0000000000000000000000000000000000068cDa');
const SHOP = getAddress('0x00000000000000000000000000000000000000b2');
const PLATFORM = getAddress('0x00000000000000000000000000000000000000a1');
const NONCE: Hex = `0x${'01'.repeat(32)}`;
const H: Hex = `0x${'ab'.repeat(32)}`;
const refs: RecordRefs = { topicNum: 7n, seq: [1n, 2n, 3n, 4n, 5n, 6n], hashes: [H, H, H, H, H, H] };

const journals: Journal<FilingJournalRow>[] = [];
afterEach(() => journals.splice(0).forEach((j) => j.close()));

/** A chain that knows no claim yet, whose vault holds `held`; it records every read and refuses to sign. */
function chain(held: Address) {
  const reads: string[] = [];
  const claimId = claimIdOf(296n, CLAIMS, orderIdOf(PLATFORM, SHOP, NONCE));
  const publicClient = {
    getChainId: async () => 296,
    readContract: async ({ functionName }: { functionName: string }) => {
      reads.push(functionName);
      if (functionName === 'claimIdFor') return claimId;
      if (functionName === 'getClaim') return { status: 0 };
      if (functionName === 'usdc') return held;
      if (functionName === 'params') return { courtFeeUsdc: 1_000_000n };
      if (functionName === 'allowance') return 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  const clients = { publicClient, account: { address: SHOP, signTransaction: () => Promise.reject(new Error('signing reached')) }, hedera: false } as unknown as ChainClients;
  return { clients, reads };
}

function filer(clients: ChainClients, usdc: Address) {
  const journal = Journal.open<FilingJournalRow>(join(mkdtempSync(join(tmpdir(), 'filing-')), 'claims.jsonl'));
  journals.push(journal);
  return { filer: new ClaimFiler({ clients, claims: CLAIMS, vault: VAULT, usdc, claimsAbi: [], journal }), journal };
}

describe('claim filing, vault token', () => {
  it('approves nothing when the vault holds a token other than the deployment names', async () => {
    const c = chain(FACADE);
    const { filer: f, journal } = filer(c.clients, MOCK);
    const err = await f.fileClaim({ orderNonce: NONCE, platform: PLATFORM, refs, basketUsdc: 2_000_000n, netLossUsdc: 2_000_000n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FilingError);
    expect((err as FilingError).code).toBe('token_mismatch');
    expect((err as Error).message).toContain(`the vault holds ${FACADE}, the deployment names ${MOCK}`);
    expect(c.reads).not.toContain('allowance');
    expect([...journal.rows()]).toEqual([]);
  });

  it('goes on to the allowance when the vault holds the deployment token, in any case', async () => {
    const c = chain(MOCK.toLowerCase() as Address);
    const { filer: f } = filer(c.clients, MOCK);
    await expect(f.fileClaim({ orderNonce: NONCE, platform: PLATFORM, refs, basketUsdc: 2_000_000n, netLossUsdc: 2_000_000n })).rejects.toThrow();
    expect(c.reads).toEqual(expect.arrayContaining(['usdc', 'params', 'allowance']));
  });
});
