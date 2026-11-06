// A chain in memory for the actions: fixed views a test can change, and a simulation that runs a
// test's rule over the decoded call (default: it passes with a fixed gas estimate).
import { claimIdOf, orderIdOf } from '@recourse/shared';
import { decodeFunctionData, encodeErrorResult, getAddress, type Abi, type Address, type Hex } from 'viem';
import { ABI_OF, type ContractLabel } from '../../src/abi/deployed.js';
import { ChainUnavailable, type ActionReads, type CaseNow, type ChainClaim, type ChainName, type ClaimTerms, type CourtNow, type EvmTx, type HederaClaimsNow, type SimResult } from '../../src/chain.js';
import { CLAIMS, PLATFORM, SHOP, ZERO32 } from './fixtures.js';

export const TOKEN = getAddress('0x' + 'c4'.repeat(20));
export const LINK_TOKEN = getAddress('0x' + 'c5'.repeat(20));
export const HEDERA_GAS_PRICE = 710_000_000_000n;
export const ARB_GAS_PRICE = 100_000_000n;

export interface Decoded {
  chain: ChainName;
  tx: EvmTx;
  fn: string;
  args: readonly unknown[];
}

export interface FakeState {
  now: bigint;
  claim: ChainClaim | null;
  terms: ClaimTerms;
  claimsNow: HederaClaimsNow;
  settle: { toShop: bigint; refund: bigint; toPool: bigint };
  quoteSend: bigint;
  handlingOf: (basket: bigint) => bigint;
  balance: bigint;
  allowance: bigint;
  gate: { exitRequestedAt: bigint; exitDelay: bigint; usdcAssociated: boolean };
  credit: bigint;
  escrow: bigint;
  kase: CaseNow | null;
  court: CourtNow;
  quoteRelay: { native: bigint; link: bigint };
  period: number | null;
  /** Decides each simulation; return a revert to refuse. */
  rule: (d: Decoded) => SimResult;
  /** Methods that answer as an RPC fault. */
  down: Set<string>;
}

/** Revert bytes for a custom error of a contract's ABI. */
export function revertOf(contract: ContractLabel, errorName: string, args: readonly unknown[] = []): SimResult {
  return { ok: false, data: encodeErrorResult({ abi: ABI_OF[contract], errorName, args } as never) };
}

export function chainClaim(over: Partial<ChainClaim> = {}): ChainClaim {
  return {
    orderId: ZERO32, shop: SHOP, platform: PLATFORM, basketUsdc: 60_000_000n, netLossUsdc: 50_000_000n, filedAt: 1_700_000_000n, preCheckedAt: 1_700_000_030n,
    gap: 1, answer: 1, packHash: ZERO32, contestedBy: '0x0000000000000000000000000000000000000000', sendCount: 0, lastSendAt: 0n, lastMessageId: ZERO32,
    disputeId: 0n, ruling: 0, attempts: 0, status: 2, ...over,
  };
}

export function caseNow(over: Partial<CaseNow> = {}): CaseNow {
  return {
    state: 1, payloadHash: ZERO32, receivedAt: 1_700_000_200n, attempts: 0, disputeIds: [0n, 0n], ruling: 0, ruledAt: 0n, sendCount: 0, lastSendAt: 0n,
    lastMessageId: ZERO32, expiresAt: 1_700_060_000n, ...over,
  };
}

const CALLED: [ContractLabel, Abi][] = (['RecourseClaims', 'DepositVault', 'RecourseCase', 'EvidenceModule', 'VaultToken'] as const).map((c) => [c, ABI_OF[c]]);

function decode(tx: EvmTx): { fn: string; args: readonly unknown[] } {
  for (const [, abi] of CALLED) {
    try {
      const d = decodeFunctionData({ abi, data: tx.data });
      return { fn: d.functionName, args: d.args ?? [] };
    } catch {
      // another contract's function
    }
  }
  throw new Error('undecodable call');
}

export function fakeChain(over: Partial<FakeState> = {}): ActionReads & { state: FakeState; sims: Decoded[]; calls: string[] } {
  const state: FakeState = {
    now: 1_700_000_100n,
    claim: null,
    terms: { contestWindow: 600n, claimTimeout: 14_400n, handling: 18_000_000n },
    claimsNow: { courtFeeUsdc: 3_000_000n, resendGap: 1_800n, maxSends: 5, bridgeMode: 0, peer: getAddress('0x' + 'c3'.repeat(20)), feeToken: LINK_TOKEN },
    settle: { toShop: 0n, refund: 0n, toPool: 0n },
    quoteSend: 2_000_000_000_000_000n,
    handlingOf: (b) => {
      const h = 15_000_000n + (b * 500n) / 10_000n;
      return h < 40_000_000n ? h : 40_000_000n;
    },
    balance: 10_000_000n,
    allowance: 0n,
    gate: { exitRequestedAt: 0n, exitDelay: 600n, usdcAssociated: true },
    credit: 0n,
    escrow: 3_000_000n,
    kase: null,
    court: { costNow: 50_000_000_000_000n, feePool: 1_000_000_000_000_000n, openCases: 0, maxOpenCases: 10, caseDeadline: 7_200n, resendGap: 1_800n, maxSends: 5, peer: CLAIMS },
    quoteRelay: { native: 30_000_000_000_000n, link: 40_000_000_000_000_000n },
    period: 0,
    rule: () => ({ ok: true, gas: 100_000n }),
    down: new Set(),
    ...over,
  };
  const sims: Decoded[] = [];
  const calls: string[] = [];
  const at = <T>(name: string, chain: ChainName, v: () => T): Promise<T> => {
    calls.push(name);
    if (state.down.has(name)) return Promise.reject(new ChainUnavailable(chain));
    return Promise.resolve(v());
  };
  const none = () => chainClaim({ status: 0, shop: '0x0000000000000000000000000000000000000000', platform: '0x0000000000000000000000000000000000000000' });
  const reads: ActionReads = {
    head: (chain) => at(`head:${chain}`, chain, () => ({ number: 100n, timestamp: state.now })),
    gasPrice: (chain) => at(`gasPrice:${chain}`, chain, () => (chain === 'hedera' ? HEDERA_GAS_PRICE : ARB_GAS_PRICE)),
    simulate: (chain, tx) =>
      at('simulate', chain, () => {
        const d = { chain, tx, ...decode(tx) };
        sims.push(d);
        return state.rule(d);
      }),
    claim: () => at('claim', 'hedera', () => state.claim ?? none()),
    claimTerms: () => at('claimTerms', 'hedera', () => state.terms),
    claimsNow: () => at('claimsNow', 'hedera', () => state.claimsNow),
    previewSettle: () => at('previewSettle', 'hedera', () => state.settle),
    quoteSend: () => at('quoteSend', 'hedera', () => state.quoteSend),
    handlingOf: (b) => at('handlingOf', 'hedera', () => state.handlingOf(b)),
    claimIdFor: (platform: Address, shop: Address, nonce: Hex) => at('claimIdFor', 'hedera', () => claimIdOf(296, CLAIMS, orderIdOf(platform, shop, nonce))),
    vaultToken: () => at('vaultToken', 'hedera', () => TOKEN),
    tokenOf: () => at('tokenOf', 'hedera', () => ({ balance: state.balance, allowance: state.allowance })),
    vaultGate: () => at('vaultGate', 'hedera', () => state.gate),
    creditOf: () => at('creditOf', 'hedera', () => state.credit),
    escrowOf: () => at('escrowOf', 'hedera', () => state.escrow),
    caseNow: () => at('caseNow', 'arbitrum', () => state.kase ?? caseNow({ state: 0 })),
    courtNow: () => at('courtNow', 'arbitrum', () => state.court),
    quoteRelay: (_id, native) => at('quoteRelay', 'arbitrum', () => (native ? state.quoteRelay.native : state.quoteRelay.link)),
    period: () => at('period', 'arbitrum', () => state.period),
  };
  return Object.assign(reads, { state, sims, calls });
}
