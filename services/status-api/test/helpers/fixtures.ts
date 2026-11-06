// Scenario fixtures: one claim per status key, built from realistic ids and events.
import { claimIdOf, orderIdOf, type Answer, type Gap } from '@recourse/shared';
import { getAddress, type Address, type Hex } from 'viem';
import { decodeLog } from '../../src/decode.js';
import type { LiveState, RawCaseView } from '../../src/store.js';
import { Store } from '../../src/store.js';
import type { Reader } from '../../src/live.js';
import { Sim, nextTx } from './encode.js';

export const PLATFORM = getAddress('0x' + '11'.repeat(20));
export const SHOP = getAddress('0x' + '22'.repeat(20));
export const SHOP2 = getAddress('0x' + '23'.repeat(20));
export const CLAIMS = getAddress('0x' + 'c1'.repeat(20));
export const VAULT = getAddress('0x' + 'c2'.repeat(20));
export const CASE = getAddress('0x' + 'c3'.repeat(20));
export const TOPIC = '0.0.4000';
export const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

export const WINDOW = 600n;
export const TIMEOUT = 14_400n;
export const CASE_DEADLINE = 7_200n;
export const FEE = 3_000_000n;

export function h32(n: number | string): Hex {
  return ('0x' + (typeof n === 'number' ? n.toString(16) : n).padStart(64, '0').slice(-64)) as Hex;
}

export function nonce(n: number): Hex {
  return h32(0xaa00 + n);
}

export function refsFor(hashes: Hex[] = [], seqs: number[] = []) {
  return {
    topicNum: 4000n,
    seq: [0, 1, 2, 3, 4, 5].map((i) => BigInt(seqs[i] ?? 0)) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint],
    hashes: [0, 1, 2, 3, 4, 5].map((i) => hashes[i] ?? ZERO32) as unknown as readonly [Hex, Hex, Hex, Hex, Hex, Hex],
  };
}

export type Stage =
  | 'filed'
  | 'finding_made'
  | 'no_finding'
  | 'window_lapsed'
  | 'closed_uncontested'
  | 'contested'
  | 'at_court'
  | 'stuck_failed'
  | 'stuck_untouched'
  | 'at_court_fresh'
  | 'refused_once'
  | 'ruled'
  | 'zero_twice_answer_applied'
  | 'unresolved'
  | 'settled'
  | 'expired';

export interface Built {
  sim: Sim;
  claimId: Hex;
  orderId: Hex;
  nonce: Hex;
  now: bigint;
  live: LiveState | null;
  sendMsg: Hex;
  backMsg: Hex;
  expectKey: string;
}

const T0 = 1_700_000_000n;

/** Emits the events for one claim up to `stage`. `n` makes ids unique inside a scenario. */
export function buildClaim(sim: Sim, stage: Stage, n = 1, opts: { shop?: Address; basket?: bigint; netLoss?: bigint; hashes?: Hex[]; seqs?: number[] } = {}): Built {
  const shop = opts.shop ?? SHOP;
  const nn = nonce(n);
  const orderId = orderIdOf(PLATFORM, shop, nn);
  const claimId = claimIdOf(296, CLAIMS, orderId);
  const basket = opts.basket ?? 60_000_000n;
  const netLoss = opts.netLoss ?? 50_000_000n;
  const sendMsg = h32(0x5e00 + n);
  const backMsg = h32(0xba00 + n);
  const out: Built = { sim, claimId, orderId, nonce: nn, now: 0n, live: null, sendMsg, backMsg, expectKey: stage };
  const fileT = sim.t;
  sim.hedera('vault', 'FeeEscrowed', { claimId, shop, amount: FEE });
  sim.hedera('claims', 'ClaimFiled', { claimId, orderId, shop, platform: PLATFORM, refs: refsFor(opts.hashes, opts.seqs), basketUsdc: basket, netLossUsdc: netLoss, filedAt: sim.t });
  out.now = sim.t + 5n;
  if (stage === 'filed') return out;

  const answer: Answer = stage === 'no_finding' || stage === 'unresolved' ? 0 : 1;
  const gap: Gap = answer === 0 ? 255 : 1;
  sim.tick(30);
  sim.hedera('claims', 'PreCheckRecorded', { claimId, gap, answer, packHash: h32(0x9a00 + n) });
  const checked = sim.t;
  out.now = checked + 10n;
  if (stage === 'finding_made' || stage === 'no_finding') return out;
  if (stage === 'window_lapsed') {
    out.now = checked + WINDOW + 1n;
    return out;
  }
  if (stage === 'closed_uncontested') {
    sim.at(checked + WINDOW + 5n);
    sim.hedera('claims', 'ClosedUncontested', { claimId, answer, toShop: 50_000_000n + 15_000_000n + 3_000_000n });
    sim.hedera('vault', 'OutcomeApplied', { claimId, platform: PLATFORM, shop, paid: 68_000_000n, refund: FEE, toPool: 0n });
    out.now = sim.t + 1n;
    return out;
  }
  if (stage === 'expired') {
    sim.at(fileT + TIMEOUT + 10n);
    sim.hedera('claims', 'ClaimExpired', { claimId });
    sim.hedera('vault', 'OutcomeApplied', { claimId, platform: PLATFORM, shop, paid: 0n, refund: FEE, toPool: 0n });
    out.now = sim.t + 1n;
    return out;
  }
  sim.tick(60);
  sim.hedera('claims', 'Contested', { claimId, by: PLATFORM });
  out.now = sim.t + 5n;
  if (stage === 'contested') return out;

  sim.tick(20);
  sim.hedera('claims', 'SentToCourt', { claimId, messageId: sendMsg });
  const sent = sim.t;
  out.now = sent + 30n;
  const caseBase: RawCaseView = {
    state: 1, payloadHash: h32(0x77), receivedAt: sent + 40n, attempts: 0, disputeIds: [0n, 0n], templateIds: [0n, 0n],
    ruling: 0, ruledAt: 0n, sendCount: 0, lastSendAt: 0n, lastMessageId: ZERO32,
  };
  const live = (exec: Record<string, number>, caseView: RawCaseView | null, disputes: number[] = []): LiveState => ({
    caseView,
    exec,
    kleros: Object.fromEntries(disputes.map((d) => [String(d), { period: 2, currentRuling: 1n, tied: false, overridden: false }])),
    at: 0,
  });
  if (stage === 'stuck_failed') {
    out.expectKey = 'stuck';
    out.live = live({ [sendMsg]: 3 }, null);
    return out;
  }
  if (stage === 'stuck_untouched') {
    out.expectKey = 'stuck';
    out.now = sent + 3_601n;
    out.live = live({ [sendMsg]: 0 }, null);
    return out;
  }
  if (stage === 'at_court_fresh') {
    out.expectKey = 'at_court';
    out.now = sent + 600n;
    out.live = live({ [sendMsg]: 0 }, null);
    return out;
  }
  sim.tick(40);
  sim.arb('ClaimReceived', { claimId, messageId: sendMsg, payload: '0x' });
  sim.tick(30);
  sim.arb('CaseOpened', { claimId, disputeId: 900n + BigInt(n), attempt: 1 });
  out.now = sim.t + 30n;
  const opened = { ...caseBase, state: 2, attempts: 1, disputeIds: [900n + BigInt(n), 0n] as const };
  if (stage === 'at_court') {
    out.live = live({ [sendMsg]: 2 }, opened, [900 + n]);
    return out;
  }
  if (stage === 'refused_once') {
    sim.tick(600);
    sim.arb('RefileNeeded', { claimId });
    out.now = sim.t + 30n;
    out.live = live({ [sendMsg]: 2 }, { ...opened, state: 3, ruling: 0, ruledAt: sim.t }, [900 + n]);
    return out;
  }
  // Ruled stages
  const ruling = stage === 'ruled' ? 1 : stage === 'settled' ? 1 : 0;
  const attempts = stage === 'ruled' || stage === 'settled' ? 1 : 2;
  sim.tick(900);
  sim.hedera('claims', 'RulingReceived', { claimId, disputeId: 900n + BigInt(n), ruling, attempts, messageId: backMsg });
  out.now = sim.t + 30n;
  out.live = live({ [sendMsg]: 2, [backMsg]: 2 }, { ...opened, state: 5, attempts, ruling, ruledAt: sim.t }, [900 + n]);
  if (stage === 'ruled' || stage === 'zero_twice_answer_applied' || stage === 'unresolved') return out;
  // settled: ruled platform 1 -> N + H + F
  sim.tick(20);
  const owed = netLoss + 15_000_000n + (basket * 500n) / 10_000n + FEE;
  sim.hedera('claims', 'Settled', { claimId, outcome: 1, toShop: owed, toPool: FEE });
  sim.hedera('vault', 'OutcomeApplied', { claimId, platform: PLATFORM, shop, paid: owed, refund: 0n, toPool: FEE });
  out.now = sim.t + 5n;
  return out;
}

export const STAGES: Stage[] = [
  'filed', 'finding_made', 'no_finding', 'window_lapsed', 'closed_uncontested', 'contested', 'at_court',
  'stuck_failed', 'stuck_untouched', 'at_court_fresh', 'refused_once', 'ruled', 'zero_twice_answer_applied',
  'unresolved', 'settled', 'expired',
];

/** Decodes a sim's logs through the real decoder into a store. */
export function ingest(store: Store, sim: Sim, filter?: (chain: string) => boolean): void {
  const events = [];
  for (const l of sim.logs) {
    if (filter && !filter(l.chain)) continue;
    const e = decodeLog(l.chain, l.contract, l.raw);
    if (!e) throw new Error(`fixture failed to decode: ${l.contract}.${l.raw.logIndex}`);
    events.push(e);
  }
  store.addEvents(events);
}

/** A reader that returns fixed values and records what it was asked. */
export function fakeReader(over: Partial<Reader> = {}): Reader & { calls: string[] } {
  const calls: string[] = [];
  const r: Reader = {
    async claimsParams() {
      return { contestWindow: WINDOW, claimTimeout: TIMEOUT, courtFeeUsdc: FEE, handlingBase: 15_000_000n, handlingBps: 500n, handlingCap: 40_000_000n, resendGap: 1800n, maxSends: 5 };
    },
    async caseParams() {
      return { caseDeadline: CASE_DEADLINE, maxOpenCases: 10, resendGap: 1800n, maxSends: 5 };
    },
    async vaultParams() {
      return { topUpWindow: 604_800n, exitDelay: 600n, minDeposit: 10_000_000n };
    },
    async facts() {
      return {
        claims: { owner: PLATFORM, preCheckSigner: SHOP, configLocked: false, bridgeMode: 0, peer: CASE, rulingRelayer: SHOP, extraArgs: '0x' },
        vault: { owner: PLATFORM, configLocked: false, totals: { deposits: 1n, escrow: 2n, credits: 3n } },
        case: { owner: PLATFORM, locked: false, peer: CLAIMS, trustedRelay: SHOP, extraArgs: '0x', policyURI: '/ipfs/policy', feePool: 5n, openCases: 0 },
      };
    },
    async caseOf() {
      throw new Error('no case');
    },
    async executionState() {
      return 0;
    },
    async kleros() {
      return { period: 0, currentRuling: 0n, tied: false, overridden: false };
    },
    async party() {
      return { deposit: 100_000_000n, required: 10_000_000n, credit: 0n, topUpDeadline: 0n, inGoodStanding: true, openClaims: 0n, exitRequestedAt: 0n, shopEscrow: 0n };
    },
    async locks() {
      return { claims: false, vault: false, case: false };
    },
    async preCheckedAt() {
      return 0n;
    },
    // Not read unless a test gives terms: the current parameters stand in.
    async claimTerms() {
      throw new Error('no terms');
    },
    ...over,
  };
  return new Proxy(r, {
    get(t, p: string) {
      if (p === 'calls') return calls;
      const v = (t as unknown as Record<string, unknown>)[p];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        calls.push(`${p}:${a.map(String).join(',')}`);
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  }) as Reader & { calls: string[] };
}
void nextTx;
void T0;
