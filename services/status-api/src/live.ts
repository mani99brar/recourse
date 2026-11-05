// Live reads: contract views, CCIP OffRamp execution state and KlerosCore. `Reader` is the seam
// the tests replace with a fake; `ViemReader` is the real one.

import { createPublicClient, fallback, http, type Address, type Hex, type PublicClient } from 'viem';
import { caseAbi } from './abi/case.js';
import { claimsAbi } from './abi/claims.js';
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

  async caseOf(claimId: Hex): Promise<RawCaseView> {
    const v = await this.arb.readContract({
      address: this.cfg.caseAddress,
      abi: caseAbi,
      functionName: 'caseOf',
      args: [claimId],
      blockNumber: await this.arbBlock(),
    });
    return {
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

/** Time-limited memo for views that change slowly. */
export class TtlCache<T> {
  private m = new Map<string, { at: number; value: Promise<T> }>();
  constructor(
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.m.get(key);
    const t = this.now();
    if (hit && t - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.m.set(key, { at: t, value });
    value.catch(() => this.m.delete(key));
    return value;
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
  const errors: string[] = [];
  for (const id of store.claimIds()) {
    const evs = store.eventsOf(id);
    const claim = foldClaim(evs);
    if (!claim || isTerminal(claim.status) || claim.status === ClaimStatus.Ruled) continue;
    const touched = claim.toCourt.length > 0 || evs.some((e) => e.contract === 'case');
    if (!touched) continue;
    const live = store.live.get(id) ?? { caseView: null, exec: {}, kleros: {}, at: 0 };
    try {
      live.caseView = await reader.caseOf(claim.claimId);
    } catch (e) {
      errors.push(safeError(e));
    }
    const probe = [
      ...bridgeless(claim.toCourt, 'arbitrum'),
      ...bridgeless(claim.relayed, 'hedera'),
    ];
    for (const m of probe) {
      if (live.exec[m.messageId] === 2) continue;
      try {
        live.exec[m.messageId] = await reader.executionState(m.chain, m.messageId);
      } catch (e) {
        errors.push(safeError(e));
      }
    }
    const disputes = live.caseView ? live.caseView.disputeIds : claim.disputeIds;
    for (const d of disputes) {
      if (d === 0n) continue;
      try {
        live.kleros[d.toString()] = await reader.kleros(d);
      } catch (e) {
        errors.push(safeError(e));
      }
    }
    live.at = nowS();
    store.live.set(id, live);
  }
  if (errors.length > 0) {
    const st = store.status.arbitrum;
    st.lastError = errors[0] ?? null;
    st.lastErrorAt = nowS();
  }
}

const ZERO32 = '0x' + '00'.repeat(32);
function bridgeless(refs: readonly { messageId: Hex }[], destination: 'hedera' | 'arbitrum') {
  return refs.filter((m) => m.messageId !== ZERO32).map((m) => ({ messageId: m.messageId, chain: destination }));
}
