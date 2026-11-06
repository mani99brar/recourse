// Test double for the keeper's chain port: an in-memory Hedera claims contract and Arbitrum case
// contract with the same guards as the real ones, plus a hand-driven CCIP and Kleros. Calls the
// keeper sends change state and queue the events the real contracts would emit; the test moves
// the clock and plays the other parties (pre-check, contester, bridge, court). Test use only.

import {
  BridgeMode,
  CaseState,
  ClaimStatus,
  DecodeStatus,
  ExecutionState,
  canExpireClaim,
  claimExpiresAfter,
  encodeClaimToCourt,
  tryDecodeClaimToCourt,
  type CaseView,
  type Claim,
} from '@recourse/shared';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { JournalRecord } from '../src/journal.js';
import type {
  CallResult,
  CaseParams,
  Chain,
  ChainEvent,
  Chains,
  ClaimsParams,
  DisputeInfo,
  KeeperCall,
  OpenIntentStatus,
  ResolvedCall,
  RulingRead,
  SortitionRead,
} from '../src/types.js';

export const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;

export const SHOP = '0x00000000000000000000000000000000000005a0' as Address;
export const PLATFORM = '0x00000000000000000000000000000000000003a0' as Address;
export const CONTESTER = '0x00000000000000000000000000000000000004a0' as Address;

export function claimIdN(n: number): Hex {
  return keccak256(toHex(`claim-${n}`));
}

type Revert = { kind: 'reverted'; error: string; args?: readonly unknown[] };
const revert = (error: string, ...args: unknown[]): Revert => ({ kind: 'reverted', error, args });

export class FakeChains implements Chains {
  readonly caseAddress = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9' as Address;
  readonly arbChainId = 421614;
  readonly opsArb = '0x00000000000000000000000000000000000a4b01' as Address;
  readonly opsHedera = '0x00000000000000000000000000000000000a4b02' as Address;

  /** Chain time, unix seconds (both chains share it here). */
  t = 1_800_000_000;
  claimsParamsV: ClaimsParams = { contestWindow: 600, claimTimeout: 64_800, resendGap: 3600, maxSends: 3 };
  caseParamsV: CaseParams = { caseDeadline: 3600, maxOpenCases: 10, resendGap: 3600, maxSends: 3, claimTimeout: 64_800 };
  mode: BridgeMode = BridgeMode.Both;
  readonly claims = new Map<string, Claim>();
  readonly cases = new Map<string, CaseView>();
  readonly exec = new Map<string, ExecutionState>();
  readonly disputes = new Map<string, DisputeInfo>();
  readonly rulings = new Map<string, RulingRead>();
  /** Whether the arbitrator exposes dispute views (the local mock does not). */
  disputeViews = true;
  sortitionV: SortitionRead = { phase: 0, lastPhaseChange: 0, minStakingTime: 3600, maxDrawingTime: 3600, disputesWithoutJurors: 0n };
  feePoolV = 10n ** 17n;
  costV = 10n ** 16n;
  caseLink = 10n ** 19n;
  linkShort = false;
  readonly credit = new Map<string, bigint>();
  paramsFail = false;
  readonly calls: KeeperCall[] = [];
  /** Per-function override: return a result to replace the contract behaviour. */
  readonly overrides = new Map<string, (call: KeeperCall) => CallResult | undefined>();
  loaded?: readonly JournalRecord[];
  /** Open intents as `${chain}:${fn}:${claimId}`; a send that comes back pending stays here until settled. */
  readonly open = new Set<string>();
  /** Calls the next resolveOpen settles (tests push them, then they are handed over once). */
  settleNext: ResolvedCall[] = [];
  /** What the last resolveOpen was told about rebroadcasting each chain, by `${chain}:${call}`. */
  readonly rebroadcastAsked = new Map<string, boolean>();
  /** Open-intent status the machine alerts on. */
  intentStatusV: OpenIntentStatus[] = [];

  private hederaQ: ChainEvent[] = [];
  private arbQ: ChainEvent[] = [];
  private n = 0;
  private nextDispute = 100n;

  // ---------------------------------------------------------------- port

  load(records: readonly JournalRecord[]): void {
    this.loaded = records;
  }

  async pollHedera(): Promise<ChainEvent[]> {
    return [...this.hederaQ];
  }
  commitHedera(events: readonly ChainEvent[]): void {
    this.hederaQ = this.hederaQ.filter((e) => !events.includes(e));
  }
  async pollArbitrum(filter: { onCaseEvents: (events: readonly ChainEvent[]) => void }): Promise<ChainEvent[]> {
    const cases = this.arbQ.filter((e) => e.source === 'case');
    filter.onCaseEvents(cases);
    return this.arbQ.filter((e) => e.source !== 'case');
  }
  commitArbitrum(): void {
    this.arbQ = [];
  }

  async getClaim(claimId: Hex): Promise<Claim> {
    const c = this.claims.get(claimId.toLowerCase());
    if (!c) throw new Error(`no claim ${claimId}`);
    return { ...c };
  }
  async claimsParams(): Promise<ClaimsParams> {
    if (this.paramsFail) throw new Error('params() unreadable');
    return { ...this.claimsParamsV };
  }
  async bridgeMode(): Promise<BridgeMode> {
    return this.mode;
  }
  async caseOf(claimId: Hex): Promise<CaseView> {
    return { ...(this.cases.get(claimId.toLowerCase()) ?? emptyCase()) };
  }
  async caseParams(): Promise<CaseParams> {
    if (this.paramsFail) throw new Error('params() unreadable');
    return { ...this.caseParamsV };
  }
  async feePool(): Promise<bigint> {
    return this.feePoolV;
  }
  async costNow(): Promise<bigint> {
    return this.costV;
  }
  /** Cases holding an open-case slot: Opened and RefilePending, as on the real contract. */
  async openCases(): Promise<number> {
    return [...this.cases.values()].filter((c) => c.state === CaseState.Opened || c.state === CaseState.RefilePending).length;
  }
  async execState(destination: Chain, messageId: Hex): Promise<ExecutionState> {
    return this.exec.get(`${destination}:${messageId.toLowerCase()}`) ?? ExecutionState.Untouched;
  }
  async dispute(disputeId: bigint): Promise<DisputeInfo> {
    if (!this.disputeViews) throw new Error('execution reverted');
    const d = this.disputes.get(disputeId.toString());
    if (!d) throw new Error(`no dispute ${disputeId}`);
    return { ...d };
  }
  async currentRuling(disputeId: bigint): Promise<RulingRead> {
    return this.rulings.get(disputeId.toString()) ?? { ruling: 0n, tied: true, overridden: false };
  }
  async sortition(): Promise<SortitionRead> {
    return { ...this.sortitionV };
  }
  async creditOf(account: Address): Promise<bigint> {
    return this.credit.get(account.toLowerCase()) ?? 0n;
  }
  async quoteRelay(): Promise<{ link: bigint; native: bigint }> {
    return { link: 10n ** 17n, native: 10n ** 15n };
  }
  async levels() {
    return { opsHederaWeibar: 10n ** 20n, opsArbWei: 10n ** 18n, claimsLink: 10n ** 19n, caseLink: this.caseLink };
  }
  hasOpen(chain: Chain, fn: string, claimId: Hex): boolean {
    return this.open.has(`${chain}:${fn}:${claimId.toLowerCase()}`);
  }
  async resolveOpen(opts: { rebroadcast?: (chain: Chain, call: string) => boolean } = {}): Promise<ResolvedCall[]> {
    for (const key of this.open) {
      const [chain, call] = key.split(':') as [Chain, string];
      this.rebroadcastAsked.set(`${chain}:${call}`, opts.rebroadcast?.(chain, call) ?? true);
    }
    const out = this.settleNext;
    this.settleNext = [];
    for (const s of out) if (s.claimId) this.open.delete(`${s.chain}:${s.call}:${s.claimId.toLowerCase()}`);
    return out;
  }
  intentStatus(): OpenIntentStatus[] {
    return this.intentStatusV;
  }
  /** Open intent records a compaction must keep (the fake signs nothing; tests put records here). */
  intentRecords: JournalRecord[] = [];
  openIntentRecords(): JournalRecord[] {
    return this.intentRecords;
  }

  async send(call: KeeperCall): Promise<CallResult> {
    this.calls.push(call);
    const o = this.overrides.get(call.fn)?.(call);
    if (o) {
      // A pending result leaves the intent open, as the real sender does.
      if (o.kind === 'pending' && call.claimId) this.open.add(`${call.chain}:${call.fn}:${call.claimId.toLowerCase()}`);
      return o;
    }
    const r = this.apply(call);
    if (r) return r;
    return { kind: 'ok', hash: this.txHash() };
  }

  /** Runs a call's contract behaviour without a send (a pending transaction that has now mined). */
  mine(call: KeeperCall): void {
    this.apply(call);
  }

  // ---------------------------------------------------------------- contract behaviour

  private apply(call: KeeperCall): Revert | undefined {
    const id = typeof call.args[0] === 'string' ? (call.args[0] as Hex).toLowerCase() : '';
    const c = this.claims.get(id);
    const p = this.claimsParamsV;
    switch (call.fn) {
      case 'closeUncontested': {
        if (!c || c.status !== ClaimStatus.PreChecked) return revert('WrongStatus', c?.status);
        if (BigInt(this.t) <= c.preCheckedAt + BigInt(p.contestWindow)) return revert('WindowOpen');
        c.status = ClaimStatus.Closed;
        this.emitH('ClosedUncontested', { claimId: id, answer: c.answer, toShop: 0n });
        return;
      }
      case 'sendToCourt': {
        if (!c || c.status !== ClaimStatus.Contested) return revert('WrongStatus', c?.status);
        c.status = ClaimStatus.AtCourt;
        c.lastSendAt = BigInt(this.t);
        let messageId = ZERO32;
        if (this.mode !== BridgeMode.None) {
          c.sendCount = 1;
          messageId = this.msgId();
          c.lastMessageId = messageId;
        }
        this.emitH('SentToCourt', { claimId: id, messageId });
        return;
      }
      case 'resend': {
        if (!c || c.status !== ClaimStatus.AtCourt) return revert('WrongStatus', c?.status);
        if (this.mode === BridgeMode.None) return revert('WrongMode', this.mode);
        if (BigInt(this.t) < c.lastSendAt + BigInt(p.resendGap)) return revert('ResendTooSoon');
        if (c.sendCount >= p.maxSends) return revert('MaxSendsReached');
        c.sendCount += 1;
        c.lastSendAt = BigInt(this.t);
        const messageId = this.msgId();
        c.lastMessageId = messageId;
        this.emitH('SentToCourt', { claimId: id, messageId });
        return;
      }
      case 'expireClaim': {
        // Filed counts from filedAt, Contested and AtCourt from preCheckedAt; strictly after.
        if (!c) return revert('WrongStatus', 0);
        const after = claimExpiresAfter(c, BigInt(p.claimTimeout));
        if (after === null) return revert('WrongStatus', c.status);
        if (!canExpireClaim(c, BigInt(p.claimTimeout), BigInt(this.t))) return revert('NotExpired', after);
        c.status = ClaimStatus.Expired;
        this.emitH('ClaimExpired', { claimId: id });
        return;
      }
      case 'recordRuling': {
        if (this.mode === BridgeMode.Both) return revert('WrongMode', this.mode);
        if (!c || c.status !== ClaimStatus.AtCourt) return revert('WrongStatus', c?.status);
        c.status = ClaimStatus.Ruled;
        c.ruling = Number(call.args[2]) as Claim['ruling'];
        this.emitH('RulingReceived', { claimId: id, disputeId: call.args[1], ruling: call.args[2], attempts: call.args[3], messageId: ZERO32 });
        return;
      }
      case 'settle': {
        if (!c || c.status !== ClaimStatus.Ruled) return revert('WrongStatus', c?.status);
        c.status = ClaimStatus.Settled;
        this.emitH('Settled', { claimId: id, outcome: c.ruling, toShop: 0n, toPool: 0n });
        return;
      }
      case 'openCase':
      case 'refile': {
        const d = tryDecodeClaimToCourt(call.args[0] as Hex);
        if (d.status !== DecodeStatus.Ok) return revert('BadPayload');
        const cid = d.value.claimId.toLowerCase();
        const cv = this.cases.get(cid);
        const want = call.fn === 'openCase' ? CaseState.Received : CaseState.RefilePending;
        if (!cv || cv.state !== want) return revert('WrongState', cid, cv?.state ?? 0);
        // At or after the case deadline or expiresAt: Stale, nothing spent, the call succeeds.
        const from = call.fn === 'openCase' ? cv.receivedAt : cv.ruledAt;
        if (BigInt(this.t) >= from + BigInt(this.caseParamsV.caseDeadline) || BigInt(this.t) >= (cv.expiresAt ?? 0n)) {
          this.stale(cid as Hex);
          return;
        }
        if (this.feePoolV < this.costV) return revert('FeePoolLow', this.feePoolV, this.costV);
        const attempt = call.fn === 'openCase' ? 1 : 2;
        const disputeId = this.nextDispute++;
        cv.state = CaseState.Opened;
        cv.attempts = attempt;
        cv.disputeIds = attempt === 1 ? [disputeId, 0n] : [cv.disputeIds[0], disputeId];
        this.feePoolV -= this.costV;
        this.disputes.set(disputeId.toString(), { courtId: 8n, period: 0, ruled: false, lastPeriodChange: this.t, timesPerPeriod: [900, 2700, 1800, 2700] });
        this.emitA('case', 'CaseOpened', { claimId: cid, disputeId, attempt });
        return;
      }
      case 'submitEvidence': {
        this.emitA('evidence', 'Evidence', { _externalDisputeID: call.args[0], _party: this.opsArb, _evidence: call.args[1] });
        return;
      }
      case 'relayRuling': {
        const cv = this.cases.get(id);
        if (!cv || (cv.state !== CaseState.Ruled && cv.state !== CaseState.Relayed)) return revert('WrongState', id, cv?.state ?? 0);
        if (cv.state === CaseState.Relayed) {
          if (BigInt(this.t) < cv.lastSendAt + BigInt(this.caseParamsV.resendGap)) return revert('SendTooSoon');
          if (cv.sendCount >= this.caseParamsV.maxSends) return revert('MaxSendsReached');
        }
        if (this.linkShort && (call.value ?? 0n) === 0n) return revert('InsufficientLink', 0n, 10n ** 17n);
        const messageId = this.msgId();
        cv.state = CaseState.Relayed;
        cv.sendCount += 1;
        cv.lastSendAt = BigInt(this.t);
        cv.lastMessageId = messageId;
        this.emitA('case', 'RulingRelayed', { claimId: id, disputeId: cv.disputeIds[cv.attempts - 1], ruling: cv.ruling, messageId });
        return;
      }
      case 'markStale': {
        const cv = this.cases.get(id);
        const staleable: readonly CaseState[] = [CaseState.Received, CaseState.Opened, CaseState.RefilePending];
        if (!cv || !staleable.includes(cv.state)) return revert('WrongState', id, cv?.state ?? 0);
        if (BigInt(this.t) < (cv.expiresAt ?? 0n)) return revert('NotExpired', cv.expiresAt);
        this.stale(id as Hex);
        return;
      }
      case 'relayClaim': {
        if (this.mode !== BridgeMode.None) return revert('RelayDisabled');
        const d = tryDecodeClaimToCourt(call.args[0] as Hex);
        if (d.status !== DecodeStatus.Ok) return revert('BadPayload');
        const cid = d.value.claimId.toLowerCase();
        if (this.cases.has(cid)) return revert('WrongState', cid, this.cases.get(cid)!.state);
        this.cases.set(cid, { ...emptyCase(), state: CaseState.Received, receivedAt: BigInt(this.t), expiresAt: this.expiresAtOf(d.value.filedAt) });
        this.emitA('case', 'ClaimReceived', { claimId: cid, messageId: ZERO32, payload: call.args[0] });
        return;
      }
      default:
        return; // Kleros nudges: accepted
    }
  }

  // ---------------------------------------------------------------- other parties

  /** A shop files a claim (Hedera). */
  file(n: number): Hex {
    const id = claimIdN(n);
    const refs = { topicNum: 1234n, seq: [1n, 2n, 3n, 4n, 5n, 6n] as const, hashes: [ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32] as const };
    this.claims.set(id, {
      orderId: keccak256(toHex(`order-${n}`)),
      shop: SHOP,
      platform: PLATFORM,
      refs,
      basketUsdc: 20_000_000n,
      netLossUsdc: 20_000_000n,
      filedAt: BigInt(this.t),
      preCheckedAt: 0n,
      gap: 0,
      answer: 0,
      packHash: ZERO32,
      contestedBy: ZERO_ADDR,
      sendCount: 0,
      lastSendAt: 0n,
      lastMessageId: ZERO32,
      disputeId: 0n,
      ruling: 0,
      attempts: 0,
      status: ClaimStatus.Filed,
    });
    this.emitH('ClaimFiled', { claimId: id, orderId: keccak256(toHex(`order-${n}`)), shop: SHOP, platform: PLATFORM, refs, basketUsdc: 20_000_000n, netLossUsdc: 20_000_000n, filedAt: BigInt(this.t) });
    return id;
  }

  /** The pre-check signer records its result. */
  precheck(id: Hex, answer: 0 | 1 | 2 | 3 = 1): void {
    const c = this.claims.get(id)!;
    c.status = ClaimStatus.PreChecked;
    c.preCheckedAt = BigInt(this.t);
    c.gap = 1;
    c.answer = answer;
    c.packHash = keccak256(toHex(`pack-${id}`));
    this.emitH('PreCheckRecorded', { claimId: id, gap: 1, answer, packHash: c.packHash });
  }

  contest(id: Hex): void {
    const c = this.claims.get(id)!;
    c.status = ClaimStatus.Contested;
    c.contestedBy = CONTESTER;
    this.emitH('Contested', { claimId: id, by: CONTESTER });
  }

  payloadOf(id: Hex): Hex {
    const c = this.claims.get(id)!;
    return encodeClaimToCourt({
      version: 1,
      claimId: id,
      platform: c.platform,
      shop: c.shop,
      gap: c.gap,
      answer: c.answer,
      refs: c.refs,
      packHash: c.packHash,
      basketUsdc: c.basketUsdc,
      netLossUsdc: c.netLossUsdc,
      filedAt: c.filedAt,
    });
  }

  /** CCIP executes the latest outbound message on Arbitrum; `record` false = receiver dropped it. */
  deliver(id: Hex, opts: { record?: boolean; messageId?: Hex } = {}): Hex {
    const messageId = (opts.messageId ?? this.claims.get(id)!.lastMessageId).toLowerCase() as Hex;
    this.exec.set(`arbitrum:${messageId}`, ExecutionState.Success);
    if (opts.record === false) return messageId;
    this.cases.set(id, { ...emptyCase(), state: CaseState.Received, receivedAt: BigInt(this.t), expiresAt: this.expiresAtOf(this.claims.get(id)!.filedAt) });
    this.emitA('case', 'ClaimReceived', { claimId: id, messageId, payload: this.payloadOf(id) });
    return messageId;
  }

  /** The case contract's expiresAt: filedAt from the payload plus its own claim timeout. */
  expiresAtOf(filedAt: bigint): bigint {
    return filedAt + BigInt(this.caseParamsV.claimTimeout);
  }

  disputeOf(id: Hex): bigint {
    const cv = this.cases.get(id)!;
    return cv.disputeIds[cv.attempts - 1]!;
  }

  draw(id: Hex): void {
    this.emitA('core', 'Draw', { _address: CONTESTER, _disputeID: this.disputeOf(id), _roundID: 0n, _voteID: 0n });
  }

  /** The court rules. Ruling 0 on attempt 1 asks for a refile; anything else is final. */
  rule(id: Hex, ruling: number): void {
    const cv = this.cases.get(id)!;
    const disputeId = this.disputeOf(id);
    if (cv.state !== CaseState.Opened) {
      this.emitA('case', 'RuleIgnored', { disputeId, ruling: BigInt(ruling) });
      return;
    }
    this.rulings.set(disputeId.toString(), { ruling: BigInt(ruling), tied: false, overridden: false });
    cv.ruledAt = BigInt(this.t);
    if (ruling === 0 && cv.attempts === 1) {
      cv.state = CaseState.RefilePending;
      this.emitA('case', 'RefileNeeded', { claimId: id });
      return;
    }
    cv.state = CaseState.Ruled;
    cv.ruling = ruling;
    this.emitA('case', 'RulingFinal', { claimId: id, disputeId, ruling, attempts: cv.attempts });
  }

  /** CCIP executes the latest ruling message on Hedera. */
  arrive(id: Hex): void {
    const cv = this.cases.get(id)!;
    const c = this.claims.get(id)!;
    this.exec.set(`hedera:${cv.lastMessageId.toLowerCase()}`, ExecutionState.Success);
    c.status = ClaimStatus.Ruled;
    c.ruling = cv.ruling as Claim['ruling'];
    this.emitH('RulingReceived', { claimId: id, disputeId: this.disputeOf(id), ruling: cv.ruling, attempts: cv.attempts, messageId: cv.lastMessageId });
  }

  stale(id: Hex): void {
    const cv = this.cases.get(id)!;
    cv.state = CaseState.Stale;
    this.emitA('case', 'ClaimStale', { claimId: id });
  }

  emitH(name: string, args: Record<string, unknown>): void {
    this.hederaQ.push(this.event('hedera', 'claims', name, args));
  }

  emitA(source: string, name: string, args: Record<string, unknown>): void {
    this.arbQ.push(this.event('arbitrum', source, name, args));
  }

  private event(chain: Chain, source: string, name: string, args: Record<string, unknown>): ChainEvent {
    this.n += 1;
    return { chain, source, name, args, tx: this.txHash(), logIndex: 0, time: this.t, position: `${this.t}-${this.n}` };
  }

  private txHash(): Hex {
    this.n += 1;
    return keccak256(toHex(`tx-${this.n}`));
  }

  private msgId(): Hex {
    this.n += 1;
    return keccak256(toHex(`msg-${this.n}`));
  }
}

function emptyCase(): CaseView {
  return {
    state: CaseState.None,
    payloadHash: ZERO32,
    receivedAt: 0n,
    attempts: 0,
    disputeIds: [0n, 0n],
    templateIds: [0n, 0n],
    ruling: 0,
    ruledAt: 0n,
    sendCount: 0,
    lastSendAt: 0n,
    lastMessageId: ZERO32,
  };
}
