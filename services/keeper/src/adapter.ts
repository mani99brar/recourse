// The live chain port: viem reads on both chains, the two journaled senders (ops-hedera and
// ops-arb), the Hedera event source (mirror node, or eth_getLogs on a local anvil) and the
// Arbitrum log reader. Reads go to `latest`; Arbitrum events are read `confirmations` blocks
// behind the head.

import {
  ccipOffRampAbi,
  disputeKitClassicAbi,
  evidenceModuleAbi,
  klerosCoreAbi,
  sortitionModuleAbi,
  type BridgeMode,
  type CaseView,
  type Claim,
  type ExecutionState,
} from '@recourse/shared';
import { encodeFunctionData, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { caseAbi, claimsAbi, erc20Abi, vaultAbi } from './abi.js';
import type { JournalRecord } from './journal.js';
import type { BlockLogReader, EventSource, LogQuery } from './logs.js';
import { decodeRevert } from './rpc.js';
import type { Sender, SendOutcome } from './sender.js';
import type {
  CallResult,
  CaseParams,
  Chain,
  ChainEvent,
  Chains,
  ClaimsParams,
  DisputeInfo,
  KeeperCall,
  RulingRead,
  SortitionRead,
} from './types.js';

export interface LiveChainsOptions {
  hedera: {
    client: PublicClient;
    claims: Address;
    vault: Address;
    /** OffRamp executing Arbitrum -> Hedera messages. */
    offRamp: Address;
    events: EventSource;
    sender: Sender;
  };
  arbitrum: {
    client: PublicClient;
    chainId: number;
    case: Address;
    klerosCore: Address;
    evidenceModule: Address;
    disputeKit?: Address;
    sortitionModule?: Address;
    /** OffRamp executing Hedera -> Arbitrum messages. */
    offRamp: Address;
    reader: BlockLogReader;
    sender: Sender;
  };
  /** Lowest gas limits per function (measured execution gas); estimates below these are raised. */
  gasFloors?: Partial<Record<string, bigint>>;
  log?: (line: string) => void;
}

/** Measured execution gas with headroom, for calls whose estimate may miss a branch. */
export const DEFAULT_GAS_FLOORS: Record<string, bigint> = {
  openCase: 1_300_000n,
  refile: 1_300_000n,
  relayRuling: 450_000n,
};

export class LiveChains implements Chains {
  readonly caseAddress: Address;
  readonly arbChainId: number;
  private readonly timesByCourt = new Map<string, readonly [number, number, number, number]>();
  private links?: { hedera: Address; arbitrum: Address };

  constructor(private readonly o: LiveChainsOptions) {
    this.caseAddress = o.arbitrum.case;
    this.arbChainId = o.arbitrum.chainId;
  }

  get opsArb(): Address {
    return this.o.arbitrum.sender.address;
  }

  get opsHedera(): Address {
    return this.o.hedera.sender.address;
  }

  load(records: readonly JournalRecord[]): void {
    this.o.hedera.sender.load(records);
    this.o.arbitrum.sender.load(records);
  }

  // ------------------------------------------------------------------ events

  pollHedera(): Promise<ChainEvent[]> {
    return this.o.hedera.events.poll();
  }

  commitHedera(events: readonly ChainEvent[]): void {
    this.o.hedera.events.commit(events);
  }

  pollArbitrum(filter: {
    disputeIds: () => readonly bigint[];
    externalIds: () => readonly bigint[];
    onCaseEvents: (events: readonly ChainEvent[]) => void;
  }): Promise<ChainEvent[]> {
    const a = this.o.arbitrum;
    return a.reader.poll({
      between: filter.onCaseEvents,
      then: () => {
        const disputes = [...filter.disputeIds()];
        const externals = [...filter.externalIds()];
        const q: LogQuery[] = [
          { source: 'core', address: a.klerosCore, abi: klerosCoreAbi as Abi, eventName: 'Draw', args: { _disputeID: disputes } },
          { source: 'evidence', address: a.evidenceModule, abi: evidenceModuleAbi as Abi, eventName: 'Evidence', args: { _externalDisputeID: externals } },
        ];
        if (a.disputeKit) {
          for (const eventName of ['Contribution', 'ChoiceFunded']) {
            q.push({ source: 'kit', address: a.disputeKit, abi: disputeKitClassicAbi as Abi, eventName, args: { _coreDisputeID: disputes } });
          }
        }
        return q;
      },
    });
  }

  commitArbitrum(events: readonly ChainEvent[]): void {
    this.o.arbitrum.reader.commit(events);
  }

  async hederaLagS(): Promise<number> {
    return this.o.hedera.events.lagS ? this.o.hedera.events.lagS() : 0;
  }

  // ------------------------------------------------------------------ reads

  async getClaim(claimId: Hex): Promise<Claim> {
    const c = await this.o.hedera.client.readContract({ address: this.o.hedera.claims, abi: claimsAbi, functionName: 'getClaim', args: [claimId] });
    return {
      orderId: c.orderId,
      shop: c.shop,
      platform: c.platform,
      refs: {
        topicNum: c.refs.topicNum,
        seq: [...c.refs.seq] as unknown as Claim['refs']['seq'],
        hashes: [...c.refs.hashes] as unknown as Claim['refs']['hashes'],
      },
      basketUsdc: c.basketUsdc,
      netLossUsdc: c.netLossUsdc,
      filedAt: c.filedAt,
      preCheckedAt: c.preCheckedAt,
      gap: c.gap as Claim['gap'],
      answer: c.answer as Claim['answer'],
      packHash: c.packHash,
      contestedBy: c.contestedBy,
      sendCount: c.sendCount,
      lastSendAt: c.lastSendAt,
      lastMessageId: c.lastMessageId,
      disputeId: c.disputeId,
      ruling: c.ruling as Claim['ruling'],
      attempts: c.attempts,
      status: c.status as Claim['status'],
    };
  }

  async claimsParams(): Promise<ClaimsParams> {
    const p = await this.o.hedera.client.readContract({ address: this.o.hedera.claims, abi: claimsAbi, functionName: 'params' });
    return { contestWindow: Number(p.contestWindow), claimTimeout: Number(p.claimTimeout), resendGap: Number(p.resendGap), maxSends: p.maxSends };
  }

  async bridgeMode(): Promise<BridgeMode> {
    const m = await this.o.hedera.client.readContract({ address: this.o.hedera.claims, abi: claimsAbi, functionName: 'bridgeMode' });
    return m as BridgeMode;
  }

  async caseOf(claimId: Hex): Promise<CaseView> {
    const v = await this.o.arbitrum.client.readContract({ address: this.o.arbitrum.case, abi: caseAbi, functionName: 'caseOf', args: [claimId] });
    return {
      state: v.state as CaseView['state'],
      payloadHash: v.payloadHash,
      receivedAt: v.receivedAt,
      attempts: v.attempts,
      disputeIds: [v.disputeIds[0], v.disputeIds[1]],
      templateIds: [v.templateIds[0], v.templateIds[1]],
      ruling: v.ruling,
      ruledAt: v.ruledAt,
      sendCount: v.sendCount,
      lastSendAt: v.lastSendAt,
      lastMessageId: v.lastMessageId,
    };
  }

  async caseParams(): Promise<CaseParams> {
    const a = this.o.arbitrum;
    const [[caseDeadline, maxOpenCases, resendGap, maxSends], claimTimeout] = await Promise.all([
      a.client.readContract({ address: a.case, abi: caseAbi, functionName: 'params' }),
      a.client.readContract({ address: a.case, abi: caseAbi, functionName: 'claimTimeout' }),
    ]);
    return { caseDeadline: Number(caseDeadline), maxOpenCases, resendGap: Number(resendGap), maxSends, claimTimeout: Number(claimTimeout) };
  }

  feePool(): Promise<bigint> {
    return this.o.arbitrum.client.readContract({ address: this.o.arbitrum.case, abi: caseAbi, functionName: 'feePool' });
  }

  costNow(): Promise<bigint> {
    return this.o.arbitrum.client.readContract({ address: this.o.arbitrum.case, abi: caseAbi, functionName: 'costNow' });
  }

  async openCases(): Promise<number> {
    return this.o.arbitrum.client.readContract({ address: this.o.arbitrum.case, abi: caseAbi, functionName: 'openCases' });
  }

  async execState(destination: Chain, messageId: Hex): Promise<ExecutionState> {
    const side = destination === 'arbitrum' ? this.o.arbitrum : this.o.hedera;
    const st = await side.client.readContract({ address: side.offRamp, abi: ccipOffRampAbi, functionName: 'getExecutionState', args: [messageId] });
    return st as ExecutionState;
  }

  async dispute(disputeId: bigint): Promise<DisputeInfo> {
    const a = this.o.arbitrum;
    const [courtId, , period, ruled, lastPeriodChange] = await a.client.readContract({ address: a.klerosCore, abi: klerosCoreAbi, functionName: 'disputes', args: [disputeId] });
    let times = this.timesByCourt.get(courtId.toString());
    if (times === undefined) {
      const t = await a.client.readContract({ address: a.klerosCore, abi: klerosCoreAbi, functionName: 'getTimesPerPeriod', args: [courtId] });
      times = [Number(t[0]), Number(t[1]), Number(t[2]), Number(t[3])] as const;
      this.timesByCourt.set(courtId.toString(), times);
    }
    return { courtId, period, ruled, lastPeriodChange: Number(lastPeriodChange), timesPerPeriod: times };
  }

  async currentRuling(disputeId: bigint): Promise<RulingRead> {
    const a = this.o.arbitrum;
    const [ruling, tied, overridden] = await a.client.readContract({ address: a.klerosCore, abi: klerosCoreAbi, functionName: 'currentRuling', args: [disputeId] });
    return { ruling, tied, overridden };
  }

  async sortition(): Promise<SortitionRead> {
    const a = this.o.arbitrum;
    if (!a.sortitionModule) throw new Error('no sortition module on this network');
    const read = <F extends 'phase' | 'lastPhaseChange' | 'minStakingTime' | 'maxDrawingTime' | 'disputesWithoutJurors'>(functionName: F) =>
      a.client.readContract({ address: a.sortitionModule!, abi: sortitionModuleAbi, functionName });
    const [phase, lastPhaseChange, minStakingTime, maxDrawingTime, disputesWithoutJurors] = await Promise.all([
      read('phase'),
      read('lastPhaseChange'),
      read('minStakingTime'),
      read('maxDrawingTime'),
      read('disputesWithoutJurors'),
    ]);
    return {
      phase: Number(phase),
      lastPhaseChange: Number(lastPhaseChange),
      minStakingTime: Number(minStakingTime),
      maxDrawingTime: Number(maxDrawingTime),
      disputesWithoutJurors: BigInt(disputesWithoutJurors as bigint),
    };
  }

  creditOf(account: Address): Promise<bigint> {
    return this.o.hedera.client.readContract({ address: this.o.hedera.vault, abi: vaultAbi, functionName: 'creditOf', args: [account] });
  }

  async quoteRelay(claimId: Hex): Promise<{ link: bigint; native: bigint }> {
    const a = this.o.arbitrum;
    const [link, native] = await Promise.all([
      a.client.readContract({ address: a.case, abi: caseAbi, functionName: 'quoteRelay', args: [claimId] }),
      a.client.readContract({ address: a.case, abi: caseAbi, functionName: 'quoteRelayNative', args: [claimId] }),
    ]);
    return { link, native };
  }

  async levels(): Promise<{ opsHederaWeibar: bigint; opsArbWei: bigint; claimsLink: bigint; caseLink: bigint }> {
    const h = this.o.hedera;
    const a = this.o.arbitrum;
    if (this.links === undefined) {
      const [hl, al] = await Promise.all([
        h.client.readContract({ address: h.claims, abi: claimsAbi, functionName: 'link' }),
        a.client.readContract({ address: a.case, abi: caseAbi, functionName: 'link' }),
      ]);
      this.links = { hedera: hl, arbitrum: al };
    }
    const [opsHederaWeibar, opsArbWei, claimsLink, caseLink] = await Promise.all([
      h.client.getBalance({ address: this.opsHedera }),
      a.client.getBalance({ address: this.opsArb }),
      h.client.readContract({ address: this.links.hedera, abi: erc20Abi, functionName: 'balanceOf', args: [h.claims] }),
      a.client.readContract({ address: this.links.arbitrum, abi: erc20Abi, functionName: 'balanceOf', args: [a.case] }),
    ]);
    return { opsHederaWeibar, opsArbWei, claimsLink, caseLink };
  }

  // ------------------------------------------------------------------ sends

  private target(call: KeeperCall): { sender: Sender; to: Address; abi: Abi } {
    const h = this.o.hedera;
    const a = this.o.arbitrum;
    switch (call.contract) {
      case 'claims':
        return { sender: h.sender, to: h.claims, abi: claimsAbi as Abi };
      case 'case':
        return { sender: a.sender, to: a.case, abi: caseAbi as Abi };
      case 'core':
        return { sender: a.sender, to: a.klerosCore, abi: klerosCoreAbi as Abi };
      case 'evidence':
        return { sender: a.sender, to: a.evidenceModule, abi: evidenceModuleAbi as Abi };
      case 'sortition':
        if (!a.sortitionModule) throw new Error('no sortition module on this network');
        return { sender: a.sender, to: a.sortitionModule, abi: sortitionModuleAbi as Abi };
    }
  }

  async send(call: KeeperCall): Promise<CallResult> {
    const { sender, to, abi } = this.target(call);
    if (sender.chain !== call.chain) throw new Error(`${call.fn} is on ${sender.chain}, not ${call.chain}`);
    const data = encodeFunctionData({ abi, functionName: call.fn, args: call.args as unknown[] });
    const floor = (this.o.gasFloors ?? DEFAULT_GAS_FLOORS)[call.fn];
    const out = await sender.send({
      to,
      data,
      call: call.fn,
      ...(call.value !== undefined ? { value: call.value } : {}),
      ...(call.claimId ? { claimId: call.claimId } : {}),
      ...(floor !== undefined ? { gasFloor: floor } : {}),
    });
    return toCallResult(out);
  }

  async resolveOpen(): Promise<void> {
    for (const s of [this.o.hedera.sender, this.o.arbitrum.sender]) {
      for (const { intent, outcome } of await s.resolveOpen()) {
        this.o.log?.(`resolved ${intent.call} ${intent.hash} on ${intent.chain}: ${outcome.kind === 'mined' ? outcome.status : outcome.kind}`);
      }
    }
  }

  hasOpen(chain: Chain, fn: string, claimId: Hex): boolean {
    const s = chain === 'hedera' ? this.o.hedera.sender : this.o.arbitrum.sender;
    const id = claimId.toLowerCase();
    return s.openIntents().some((i) => i.call === fn && i.claimId?.toLowerCase() === id);
  }
}

export function toCallResult(out: SendOutcome): CallResult {
  switch (out.kind) {
    case 'mined': {
      if (out.status === 'success') return { kind: 'ok', hash: out.hash };
      const d = decodeRevert(out.revertData);
      return { kind: 'reverted', hash: out.hash, ...(d ? { error: d.name, args: d.args } : {}), message: 'mined and reverted' };
    }
    case 'pending':
      return { kind: 'pending', hash: out.hash };
    case 'rejected': {
      const d = decodeRevert(out.revertData);
      return { kind: 'reverted', ...(d ? { error: d.name, args: d.args } : {}), message: out.message };
    }
    case 'busy':
      return { kind: 'busy' };
    case 'dry':
      return { kind: 'dry' };
  }
}
