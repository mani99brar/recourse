// Live reads: contract views, CCIP OffRamp execution state and KlerosCore. `Reader` is the seam
// the tests replace with a fake; `ViemReader` is the real one.

import { createPublicClient, fallback, http, type Address, type Hex, type PublicClient } from 'viem';
import { caseAbi } from './abi/case.js';
import { claimsAbi } from './abi/claims.js';
import { CLAIMS_ABI } from './abi/deployed.js';
import type { ClaimTerms } from './chain.js';
import { klerosAbi, offRampAbi } from './abi/outside.js';
import { vaultAbi } from './abi/vault.js';
import { foldClaim, isTerminal } from './join.js';
import { safeError } from './http.js';
import { ClaimStatus } from '@recourse/shared';
import type { KlerosRead, RawCaseView, Store } from './store.js';

export interface ClaimsParams {
  contestWindow: bigint;
  claimTimeout: bigint;
  courtFeeUsdc: bigint;
  handlingBase: bigint;
  handlingBps: bigint;
  handlingCap: bigint;
  resendGap: bigint;
  maxSends: number;
}

export interface CaseParams {
  caseDeadline: bigint;
  maxOpenCases: number;
  resendGap: bigint;
  maxSends: number;
}

export interface VaultParams {
  topUpWindow: bigint;
  exitDelay: bigint;
  minDeposit: bigint;
}

export interface PartyViews {
  deposit: bigint;
  required: bigint;
  credit: bigint;
  topUpDeadline: bigint;
  inGoodStanding: boolean;
  openClaims: bigint;
  exitRequestedAt: bigint;
  shopEscrow: bigint;
}

export interface ContractFacts {
  claims: {
    owner: Address | null;
    preCheckSigner: Address;
    configLocked: boolean;
    bridgeMode: number;
    peer: Address;
    rulingRelayer: Address;
    extraArgs: Hex;
  };
  vault: { owner: Address | null; configLocked: boolean; totals: { deposits: bigint; escrow: bigint; credits: bigint } };
  case: {
    owner: Address | null;
    locked: boolean;
    peer: Address;
    trustedRelay: Address;
    extraArgs: Hex;
    policyURI: string;
    feePool: bigint;
    openCases: number;
  };
}

export interface Reader {
  claimsParams(): Promise<ClaimsParams>;
  caseParams(): Promise<CaseParams>;
  vaultParams(): Promise<VaultParams>;
  facts(): Promise<ContractFacts>;
  caseOf(claimId: Hex): Promise<RawCaseView>;
  /** `chain` is where the destination OffRamp lives. */
  executionState(chain: 'hedera' | 'arbitrum', messageId: Hex): Promise<number>;
  kleros(disputeId: bigint): Promise<KlerosRead>;
  party(address: Address): Promise<PartyViews>;
  /** The three config locks alone (three calls, against about fifteen for `facts`). */
  locks(): Promise<ConfigLocks>;
  /** `getClaim(claimId).preCheckedAt`; 0 while the chain has no pre-check for it. */
  preCheckedAt(claimId: Hex): Promise<bigint>;
  /** `claimTermsOf(claimId)`: the contest window, timeout and handling fixed at filing (zeros when unknown). */
  claimTerms(claimId: Hex): Promise<ClaimTerms>;
}

/** Claims and vault `configLocked`, case `locked`. A lock is one-way: once true it stays true. */
export interface ConfigLocks {
  claims: boolean;
  vault: boolean;
  case: boolean;
}

export interface ViemReaderConfig {
  hederaRpcUrls: string[];
  arbRpcUrl: string;
  timeoutMs: number;
  claims: Address;
  vault: Address;
  caseAddress: Address;
  klerosCore: Address;
  offRampHedera: Address;
  offRampArb: Address;
  /** Blocks behind the Arbitrum head used for reads. */
  arbConfirmations: number;
}

export class ViemReader implements Reader {
  private hedera: PublicClient;
  private arb: PublicClient;
  constructor(private cfg: ViemReaderConfig) {
    this.hedera = createPublicClient({
      transport: fallback(cfg.hederaRpcUrls.map((u) => http(u, { timeout: cfg.timeoutMs }))),
    }) as PublicClient;
    this.arb = createPublicClient({ transport: http(cfg.arbRpcUrl, { timeout: cfg.timeoutMs }) }) as PublicClient;
  }

  private async arbBlock(): Promise<bigint> {
    return (await this.arb.getBlockNumber({ cacheTime: 0 })) - BigInt(this.cfg.arbConfirmations);
  }

  async claimsParams(): Promise<ClaimsParams> {
    const p = await this.hedera.readContract({ address: this.cfg.claims, abi: claimsAbi, functionName: 'params' });
    return {
      contestWindow: p.contestWindow,
      claimTimeout: p.claimTimeout,
      courtFeeUsdc: p.courtFeeUsdc,
      handlingBase: p.handlingBase,
      handlingBps: BigInt(p.handlingBps),
      handlingCap: p.handlingCap,
      resendGap: p.resendGap,
      maxSends: Number(p.maxSends),
    };
  }

  async caseParams(): Promise<CaseParams> {
    const blockNumber = await this.arbBlock();
    const [caseDeadline, maxOpenCases, resendGap, maxSends] = await this.arb.readContract({
      address: this.cfg.caseAddress,
      abi: caseAbi,
      functionName: 'params',
      blockNumber,
    });
    return { caseDeadline, maxOpenCases: Number(maxOpenCases), resendGap, maxSends: Number(maxSends) };
  }

  async vaultParams(): Promise<VaultParams> {
    const [topUpWindow, exitDelay, minDeposit] = await this.hedera.readContract({
      address: this.cfg.vault,
      abi: vaultAbi,
      functionName: 'params',
    });
    return { topUpWindow, exitDelay, minDeposit };
  }

  private async owner(c: PublicClient, address: Address, abi: typeof claimsAbi | typeof vaultAbi | typeof caseAbi): Promise<Address | null> {
    try {
      return (await c.readContract({ address, abi, functionName: 'owner' } as never)) as Address;
    } catch {
      return null;
    }
  }

  async facts(): Promise<ContractFacts> {
    const h = this.hedera;
    const a = this.arb;
    const cl = this.cfg.claims;
    const rd = <T>(address: Address, abi: unknown, functionName: string, client: PublicClient = h, blockNumber?: bigint) =>
      client.readContract({ address, abi, functionName, ...(blockNumber ? { blockNumber } : {}) } as never) as Promise<T>;
    const blockNumber = await this.arbBlock();
    const [preCheckSigner, configLocked, bridgeMode, peer, rulingRelayer, extraArgs] = await Promise.all([
      rd<Address>(cl, claimsAbi, 'preCheckSigner'),
      rd<boolean>(cl, claimsAbi, 'configLocked'),
      rd<number>(cl, claimsAbi, 'bridgeMode'),
      rd<Address>(cl, claimsAbi, 'peer'),
      rd<Address>(cl, claimsAbi, 'rulingRelayer'),
      rd<Hex>(cl, claimsAbi, 'extraArgs'),
    ]);
    const [vaultLocked, totals] = await Promise.all([
      rd<boolean>(this.cfg.vault, vaultAbi, 'configLocked'),
      rd<readonly [bigint, bigint, bigint]>(this.cfg.vault, vaultAbi, 'totals'),
    ]);
    const ca = this.cfg.caseAddress;
    const [locked, cpeer, trustedRelay, cextra, policyURI, feePool, openCases] = await Promise.all([
      rd<boolean>(ca, caseAbi, 'locked', a, blockNumber),
      rd<Address>(ca, caseAbi, 'peer', a, blockNumber),
      rd<Address>(ca, caseAbi, 'trustedRelay', a, blockNumber),
      rd<Hex>(ca, caseAbi, 'extraArgs', a, blockNumber),
      rd<string>(ca, caseAbi, 'policyURI', a, blockNumber),
      rd<bigint>(ca, caseAbi, 'feePool', a, blockNumber),
      rd<number>(ca, caseAbi, 'openCases', a, blockNumber),
    ]);
    return {
      claims: {
        owner: await this.owner(h, cl, claimsAbi),
        preCheckSigner,
        configLocked,
        bridgeMode: Number(bridgeMode),
        peer,
        rulingRelayer,
        extraArgs,
      },
      vault: { owner: await this.owner(h, this.cfg.vault, vaultAbi), configLocked: vaultLocked, totals: { deposits: totals[0], escrow: totals[1], credits: totals[2] } },
      case: { owner: await this.owner(a, ca, caseAbi), locked, peer: cpeer, trustedRelay, extraArgs: cextra, policyURI, feePool, openCases: Number(openCases) },
    };
  }

  async locks(): Promise<ConfigLocks> {
    const blockNumber = await this.arbBlock();
    const [claims, vault, kase] = await Promise.all([
      this.hedera.readContract({ address: this.cfg.claims, abi: claimsAbi, functionName: 'configLocked' }),
      this.hedera.readContract({ address: this.cfg.vault, abi: vaultAbi, functionName: 'configLocked' }),
      this.arb.readContract({ address: this.cfg.caseAddress, abi: caseAbi, functionName: 'locked', blockNumber }),
    ]);
    return { claims, vault, case: kase };
  }

  async claimTerms(claimId: Hex): Promise<ClaimTerms> {
    const t = await this.hedera.readContract({ address: this.cfg.claims, abi: CLAIMS_ABI, functionName: 'claimTermsOf', args: [claimId] });
    const v = t as { contestWindow: bigint; claimTimeout: bigint; handling: bigint };
    return { contestWindow: BigInt(v.contestWindow), claimTimeout: BigInt(v.claimTimeout), handling: v.handling };
  }

  async preCheckedAt(claimId: Hex): Promise<bigint> {
    const c = await this.hedera.readContract({ address: this.cfg.claims, abi: claimsAbi, functionName: 'getClaim', args: [claimId] });
    return c.preCheckedAt;
  }

  async caseOf(claimId: Hex): Promise<RawCaseView> {
    const blockNumber = await this.arbBlock();
    const v = await this.arb.readContract({ address: this.cfg.caseAddress, abi: caseAbi, functionName: 'caseOf', args: [claimId], blockNumber });
    const expiresAt = await this.arb
      .readContract({ address: this.cfg.caseAddress, abi: caseAbi, functionName: 'expiresAt', args: [claimId], blockNumber })
      .catch(() => 0n);
    return {
      expiresAt,
      state: Number(v.state),
      payloadHash: v.payloadHash,
      receivedAt: v.receivedAt,
      attempts: Number(v.attempts),
      disputeIds: [v.disputeIds[0], v.disputeIds[1]],
      templateIds: [v.templateIds[0], v.templateIds[1]],
      ruling: Number(v.ruling),
      ruledAt: v.ruledAt,
      sendCount: Number(v.sendCount),
      lastSendAt: v.lastSendAt,
      lastMessageId: v.lastMessageId,
    };
  }

  async executionState(chain: 'hedera' | 'arbitrum', messageId: Hex): Promise<number> {
    const client = chain === 'hedera' ? this.hedera : this.arb;
    const address = chain === 'hedera' ? this.cfg.offRampHedera : this.cfg.offRampArb;
    return Number(await client.readContract({ address, abi: offRampAbi, functionName: 'getExecutionState', args: [messageId] }));
  }

  async kleros(disputeId: bigint): Promise<KlerosRead> {
    const blockNumber = await this.arbBlock();
    const [ruling, tied, overridden] = await this.arb.readContract({
      address: this.cfg.klerosCore,
      abi: klerosAbi,
      functionName: 'currentRuling',
      args: [disputeId],
      blockNumber,
    });
    let period: number | null = null;
    try {
      const d = await this.arb.readContract({
        address: this.cfg.klerosCore,
        abi: klerosAbi,
        functionName: 'disputes',
        args: [disputeId],
        blockNumber,
      });
      period = Number(d[2]);
    } catch {
      // a court without the public dispute getter still reports its ruling
    }
    return { period, currentRuling: ruling, tied, overridden };
  }

  async party(address: Address): Promise<PartyViews> {
    const v = this.cfg.vault;
    const r = <T>(functionName: string) =>
      this.hedera.readContract({ address: v, abi: vaultAbi, functionName, args: [address] } as never) as Promise<T>;
    const [deposit, required, credit, topUpDeadline, inGoodStanding, openClaims, exitRequestedAt, shopEscrow] = await Promise.all([
      r<bigint>('depositOf'),
      r<bigint>('requiredOf'),
      r<bigint>('creditOf'),
      r<bigint>('topUpDeadline'),
      r<boolean>('inGoodStanding'),
      r<bigint>('openClaimsOf'),
      r<bigint>('exitRequestedAt'),
      r<bigint>('shopEscrowOf'),
    ]);
    return { deposit, required, credit, topUpDeadline, inGoodStanding, openClaims, exitRequestedAt, shopEscrow };
  }
}

/**
 * Time-limited memo for views that change slowly, holding at most `maxEntries` keys: past that,
 * expired entries go first, then the oldest.
 */
export class TtlCache<T> {
  private m = new Map<string, { at: number; value: Promise<T> }>();
  constructor(
    private ttlMs: number,
    private now: () => number = Date.now,
    private maxEntries = 1000,
  ) {}
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.m.get(key);
    const t = this.now();
    if (hit && t - hit.at < this.ttlMs) return hit.value;
    const value = load();
    const entry = { at: t, value };
    this.m.delete(key);
    this.m.set(key, entry);
    // Only this load's own entry is removed on failure, never a newer one for the same key.
    value.catch(() => {
      if (this.m.get(key) === entry) this.m.delete(key);
    });
    if (this.m.size > this.maxEntries) this.trim(t);
    return value;
  }
  get size(): number {
    return this.m.size;
  }
  private trim(t: number): void {
    for (const [k, e] of this.m) if (t - e.at >= this.ttlMs) this.m.delete(k);
    for (const k of this.m.keys()) {
      if (this.m.size <= this.maxEntries) break;
      this.m.delete(k);
    }
  }
  clear(): void {
    this.m.clear();
  }
}

/**
 * Per-poll refresh of the live state of every claim that has reached court and is not final:
 * the Arbitrum case, each known message's execution state and the Kleros dispute. A message that
 * already succeeded is not read again. One failing read is recorded and skipped.
 */
export async function refreshLive(store: Store, reader: Reader, nowS: () => number): Promise<void> {
  // By the chain each read goes to: the case and Kleros on Arbitrum, an OffRamp on its own chain.
  const errors: Record<'hedera' | 'arbitrum', string[]> = { hedera: [], arbitrum: [] };
  const tried = { hedera: false, arbitrum: false };
  for (const id of store.claimIds()) {
    const evs = store.eventsOf(id);
    const claim = foldClaim(evs);
    if (!claim) continue;
    const touched = claim.toCourt.length > 0 || evs.some((e) => e.contract === 'case');
    if (!touched) continue;
    const live = store.live.get(id) ?? { caseView: null, exec: {}, kleros: {}, at: 0 };
    // A finished claim is read once more until its case and every message state are known.
    const finished = isTerminal(claim.status) || claim.status === ClaimStatus.Ruled;
    const messages = [...bridgeless(claim.toCourt, 'arbitrum'), ...bridgeless(claim.relayed, 'hedera')];
    if (finished && live.caseView && messages.every((m) => live.exec[m.messageId] === 2)) continue;
    tried.arbitrum = true;
    try {
      live.caseView = await reader.caseOf(claim.claimId);
      live.caseReadAt = nowS();
    } catch (e) {
      errors.arbitrum.push(safeError(e));
    }
    for (const m of messages) {
      if (live.exec[m.messageId] === 2) continue;
      tried[m.chain] = true;
      try {
        live.exec[m.messageId] = await reader.executionState(m.chain, m.messageId);
      } catch (e) {
        errors[m.chain].push(safeError(e));
      }
    }
    const disputes = live.caseView ? live.caseView.disputeIds : claim.disputeIds;
    for (const d of disputes) {
      if (d === 0n) continue;
      try {
        live.kleros[d.toString()] = await reader.kleros(d);
      } catch (e) {
        errors.arbitrum.push(safeError(e));
      }
    }
    live.at = nowS();
    store.live.set(id, live);
  }
  // A failed read keeps the value read before, so the chain is reported (degraded `live`) until a
  // refresh reads it without a failure.
  for (const chain of ['hedera', 'arbitrum'] as const) {
    if (!tried[chain]) continue;
    const lr = store.liveReads[chain];
    const first = errors[chain][0];
    if (first === undefined) {
      lr.failing = false;
      lr.okAt = nowS();
      continue;
    }
    lr.failing = true;
    const st = store.status[chain];
    st.lastError = first;
    st.lastErrorAt = nowS();
  }
}

/**
 * Reads the chain's preCheckedAt once for each pre-checked claim that does not have it yet, at
 * most `budget` a poll. A claim the chain does not show as pre-checked yet is read again later.
 */
export async function refreshPreChecks(store: Store, reader: Reader, nowS: () => number, budget = 20): Promise<void> {
  for (const id of store.claimIds()) {
    if (budget <= 0) return;
    const live = store.live.get(id);
    if (live?.preCheckedAt !== undefined) continue;
    const claim = foldClaim(store.eventsOf(id));
    if (!claim || !claim.preChecked) continue;
    budget--;
    try {
      const at = await reader.preCheckedAt(claim.claimId);
      if (at === 0n) continue;
      store.live.set(id, { ...(live ?? { caseView: null, exec: {}, kleros: {}, at: nowS() }), preCheckedAt: at });
    } catch {
      // read again next poll; the mirror time stands in meanwhile
    }
  }
}

const ZERO32 = '0x' + '00'.repeat(32);
function bridgeless(refs: readonly { messageId: Hex }[], destination: 'hedera' | 'arbitrum') {
  return refs.filter((m) => m.messageId !== ZERO32).map((m) => ({ messageId: m.messageId, chain: destination }));
}
