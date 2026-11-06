import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, getAddress, keccak256, type Address, type Hex } from 'viem';
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

/**
 * A chain where an approve from an earlier run is mined (success receipt), but the allowance it gave
 * is gone (another claim's escrow used it, or the court fee rose). Records every signature; the
 * fileClaim simulate stops the run.
 */
function chainWithSpentApprove() {
  const claimId = claimIdOf(296n, CLAIMS, orderIdOf(PLATFORM, SHOP, NONCE));
  const oldRaw: Hex = '0x01';
  const oldHash = keccak256(oldRaw);
  const signed: Hex[] = [];
  let nonce = 5;
  const publicClient = {
    getChainId: async () => 296,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'claimIdFor') return claimId;
      if (functionName === 'getClaim') return { status: 0 };
      if (functionName === 'usdc') return MOCK;
      if (functionName === 'params') return { courtFeeUsdc: 1_000_000n };
      if (functionName === 'allowance') return 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash === oldHash) return { status: 'success', transactionHash: oldHash, blockNumber: 10n, logs: [] };
      throw new Error('no receipt');
    },
    estimateGas: async () => 50_000n,
    getTransactionCount: async () => nonce,
    getGasPrice: async () => 1n,
    sendRawTransaction: async () => '0x',
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      nonce += 1;
      return { status: 'success', transactionHash: hash, blockNumber: 11n, logs: [] };
    },
    simulateContract: async () => {
      throw new Error('stop at the fileClaim simulate');
    },
  };
  const walletClient = {
    signTransaction: async (tx: { data: Hex }) => {
      signed.push(tx.data);
      return `0x02${signed.length.toString(16).padStart(2, '0')}` as Hex;
    },
  };
  const clients = { publicClient, walletClient, account: { address: SHOP }, chain: undefined, hedera: false } as unknown as ChainClients;
  const history: FilingJournalRow[] = [
    { type: 'signed', at: '2026-11-01T00:00:00.000Z', claimId, orderId: orderIdOf(PLATFORM, SHOP, NONCE), step: 'approve', txHash: oldHash, nonce: 4, raw: oldRaw },
    { type: 'mined', at: '2026-11-01T00:00:05.000Z', claimId, step: 'approve', txHash: oldHash, status: 'success', blockNumber: '10' },
  ];
  return { clients, signed, history };
}

describe('claim filing, court fee allowance', () => {
  it('approves again when an earlier mined approve no longer covers the fee', async () => {
    const c = chainWithSpentApprove();
    const journal = Journal.open<FilingJournalRow>(join(mkdtempSync(join(tmpdir(), 'filing-')), 'claims.jsonl'));
    journals.push(journal);
    for (const row of c.history) journal.append(row);
    const f = new ClaimFiler({ clients: c.clients, claims: CLAIMS, vault: VAULT, usdc: MOCK, claimsAbi: [], journal });
    await expect(f.fileClaim({ orderNonce: NONCE, platform: PLATFORM, refs, basketUsdc: 2_000_000n, netLossUsdc: 2_000_000n })).rejects.toThrow(
      'stop at the fileClaim simulate',
    );
    expect(c.signed).toHaveLength(1);
    const call = decodeFunctionData({ abi: erc20Abi, data: c.signed[0]! });
    expect(call.functionName).toBe('approve');
    expect(call.args).toEqual([VAULT, 1_000_000n]);
  });
});
