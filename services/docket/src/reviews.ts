// ERC-8004 reviews. After a `case` entity is written, the scheme wallet leaves one piece of
// feedback for each side with the Reputation registry on Hedera. The scheme wallet owns and
// operates no agent, which the registry requires of a reviewer.
//
// A review never touches the case write status: a revert or a timeout marks that side failed and
// the docket carries on. Each side goes to the agent id of the case's own platform or shop, by
// address. Each (claim, side) is sent at most once; before a retry or a restart can resend, the
// receipt of the transaction it last sent and the registry's own `NewFeedback` logs since its
// first try are checked for it.

import type { Journal, Logger } from '@recourse/records';
import { erc8004ReputationAbi } from '@recourse/shared';
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import type { ReviewPort, ReviewsView, ReviewStatus } from './docket.js';
import { outcomeKey, reasonDoc } from './reason.js';
import type { CaseRow } from './schema.js';

export type Side = 'platform' | 'shop';

export interface FeedbackArgs {
  agentId: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
}

export function feedbackCalldata(a: FeedbackArgs): Hex {
  return encodeFunctionData({
    abi: erc8004ReputationAbi,
    functionName: 'giveFeedback',
    args: [a.agentId, a.value, a.valueDecimals, a.tag1, a.tag2, a.endpoint, a.feedbackURI, a.feedbackHash],
  });
}

export type SimResult = { ok: true } | { ok: false; reason: string };

/** The chain reads and the one write the writer needs. Each throws when the request itself fails. */
export interface ReviewChain {
  /** The address that owns the agent id, or null when the id is not registered (the call reverts). */
  ownerOf(agentId: bigint): Promise<Address | null>;
  /** An `eth_call` of `giveFeedback` from `from`; a revert comes back as a reason, not a throw. */
  simulate(from: Address, args: FeedbackArgs): Promise<SimResult>;
  /**
   * Sends from the scheme wallet and waits for the receipt. `onSent` gets the hash as soon as the
   * node takes the transaction, before the wait. Throws on revert or timeout.
   */
  send(args: FeedbackArgs, onSent?: (txHash: string) => void): Promise<{ txHash: string }>;
  /** How a sent transaction ended, or null when the node does not know it (still pending, or dropped). */
  receipt(txHash: string): Promise<'success' | 'reverted' | null>;
  /**
   * A `NewFeedback` from the scheme wallet for this agent and hash, if one is on chain, looking at
   * logs from `since` (unix seconds). Throws when it cannot read every log since then.
   */
  existing(agentId: bigint, feedbackHash: Hex, since: number): Promise<{ txHash: string } | null>;
  readonly schemeAddress: Address;
}

/** ERC-8004 agent ids by EVM address (lowercase), per side. */
export interface ReviewTargets {
  platform: ReadonlyMap<string, bigint>;
  shop: ReadonlyMap<string, bigint>;
}

export interface ReviewConfig {
  valueFault: number;
  valueClear: number;
  tag1: string;
  retrySeconds: number;
  retryMax: number;
}

type ReviewRow =
  | { t: 'r'; claimId: Hex; side: Side; phase: 'intent'; at: number }
  /** The node took the transaction; whether it landed is not known yet. */
  | { t: 'r'; claimId: Hex; side: Side; phase: 'broadcast'; tx: string; at: number }
  | { t: 'r'; claimId: Hex; side: Side; phase: 'sent'; tx: string; at: number }
  | { t: 'r'; claimId: Hex; side: Side; phase: 'skipped'; reason: string; at: number }
  | { t: 'r'; claimId: Hex; side: Side; phase: 'failed'; error: string; retryAt: number; at: number };

export type ReviewJournal = Journal<ReviewRow>;
export type { ReviewRow };

interface SideState {
  intent: boolean;
  tx: string | null;
  /** The last transaction sent whose end is not recorded. */
  broadcast: string | null;
  /** Time of the first intent: no review can have been sent before it. */
  since: number | null;
  skipped: boolean;
  attempts: number;
  retryAt: number;
}

/** What a review says about each side for an outcome (1 platform, 2 shop, 3 neither). */
export function reviewValues(outcome: number, cfg: Pick<ReviewConfig, 'valueFault' | 'valueClear'>): { platform: number; shop: number } | null {
  if (outcome === 1) return { platform: cfg.valueFault, shop: cfg.valueClear };
  if (outcome === 2) return { platform: cfg.valueClear, shop: cfg.valueFault };
  if (outcome === 3) return { platform: cfg.valueClear, shop: cfg.valueClear };
  return null;
}

const SELF_FEEDBACK = /self-feedback not allowed/i;

export class ReviewWriter implements ReviewPort {
  private readonly states = new Map<string, SideState>();
  private enabled: boolean | null = null; // null until the preflight has run
  private disabledReason: string | null = null;

  constructor(
    private readonly chain: ReviewChain,
    private readonly journal: ReviewJournal,
    history: readonly ReviewRow[],
    private readonly targets: ReviewTargets,
    private readonly cfg: ReviewConfig,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {
    for (const row of history) this.apply(row);
  }

  private key(claimId: Hex, side: Side): string {
    return `${claimId}|${side}`;
  }

  private stateOf(claimId: Hex, side: Side): SideState {
    let s = this.states.get(this.key(claimId, side));
    if (s === undefined) {
      s = { intent: false, tx: null, broadcast: null, since: null, skipped: false, attempts: 0, retryAt: 0 };
      this.states.set(this.key(claimId, side), s);
    }
    return s;
  }

  private apply(row: ReviewRow): void {
    const s = this.stateOf(row.claimId, row.side);
    if (row.phase === 'intent') {
      s.intent = true;
      s.since ??= row.at;
    } else if (row.phase === 'broadcast') s.broadcast = row.tx;
    else if (row.phase === 'sent') {
      s.intent = false;
      s.tx = row.tx;
      s.broadcast = null;
    } else if (row.phase === 'skipped') {
      s.intent = false;
      s.skipped = true;
    } else {
      s.intent = false;
      s.attempts += 1;
      s.retryAt = row.retryAt;
    }
  }

  private write(row: ReviewRow): void {
    this.journal.append(row);
    this.apply(row);
  }

  statusOf(claimId: Hex): ReviewsView {
    const view = (side: Side): ReviewStatus => {
      if (this.enabled === false) return { status: 'cut' };
      const s = this.states.get(this.key(claimId, side));
      if (s === undefined) return { status: 'none' };
      if (s.tx !== null) return { status: 'sent', tx: s.tx };
      if (s.skipped) return { status: 'skipped' };
      if (s.attempts > 0 && !s.intent) return { status: 'failed' };
      return { status: 'pending' };
    };
    return { platform: view('platform'), shop: view('shop') };
  }

  /**
   * Before the first send: the agent's owner must be refused (the registry blocks self-feedback)
   * and the scheme wallet must be accepted. Any other answer turns reviews off. A request that
   * fails is no answer: the preflight runs again on the next pass.
   */
  async preflight(): Promise<boolean> {
    const id = [...this.targets.platform.values(), ...this.targets.shop.values()][0];
    if (id === undefined) return this.disable('no agent ids configured');
    const probe: FeedbackArgs = {
      agentId: id, value: 0n, valueDecimals: 0, tag1: this.cfg.tag1, tag2: 'preflight', endpoint: '', feedbackURI: '', feedbackHash: keccak256(toHex('preflight')),
    };
    try {
      const owner = await this.chain.ownerOf(id);
      if (owner === null) return this.disable('agent id is not registered');
      const asOwner = await this.chain.simulate(owner, probe);
      if (asOwner.ok || !SELF_FEEDBACK.test(asOwner.reason)) return this.disable('registry did not refuse feedback from the agent owner');
      const asScheme = await this.chain.simulate(this.chain.schemeAddress, probe);
      if (!asScheme.ok) return this.disable(`registry refused the scheme wallet: ${asScheme.reason.slice(0, 80)}`);
    } catch (error) {
      this.log.warn('reviews_preflight_retry', { error: error instanceof Error ? error.message.slice(0, 160) : 'error' });
      return false;
    }
    this.enabled = true;
    return true;
  }

  private disable(reason: string): false {
    this.enabled = false;
    this.disabledReason = reason;
    this.log.warn('reviews_disabled', { reason });
    return false;
  }

  get disabled(): string | null {
    return this.disabledReason;
  }

  async process(cases: readonly { claimId: Hex; row: CaseRow }[]): Promise<void> {
    const due: { claimId: Hex; row: CaseRow; side: Side }[] = [];
    for (const c of cases) {
      if (reviewValues(c.row.outcome, this.cfg) === null) continue;
      for (const side of ['platform', 'shop'] as const) {
        const s = this.stateOf(c.claimId, side);
        if (s.tx !== null || s.skipped) continue;
        if (s.attempts > 0 && (s.attempts >= this.cfg.retryMax || this.now() < s.retryAt)) continue;
        due.push({ ...c, side });
      }
    }
    if (due.length === 0) return;
    if (this.enabled === null && !(await this.preflight())) return;
    if (this.enabled === false) return;

    for (const { claimId, row, side } of due) {
      // Only the case's own platform and shop are reviewed, never another party's agent.
      const agentId = this.targets[side].get(row[side].toLowerCase());
      if (agentId === undefined) {
        this.log.warn('review_skipped', { claimId, side, reason: 'no agent id for the party' });
        this.write({ t: 'r', claimId, side, phase: 'skipped', reason: 'no agent id for the party', at: this.now() });
        continue;
      }
      const s = this.stateOf(claimId, side);
      try {
        if ((await this.chain.ownerOf(agentId)) === null) {
          this.log.warn('review_skipped', { claimId, side, reason: 'not registered' });
          this.write({ t: 'r', claimId, side, phase: 'skipped', reason: 'not registered', at: this.now() });
          continue;
        }
        const doc = reasonDoc(row);
        const values = reviewValues(row.outcome, this.cfg)!;
        const args: FeedbackArgs = {
          agentId,
          value: BigInt(values[side]),
          valueDecimals: 0,
          tag1: this.cfg.tag1,
          tag2: outcomeKey(row.outcome),
          endpoint: '',
          feedbackURI: row.reasonCid ? `ipfs://${row.reasonCid}` : '',
          feedbackHash: doc.hash,
        };
        // A previous try may have landed without being recorded: a receipt wait that timed out, or
        // a run cut off mid-send.
        if (s.broadcast !== null && (await this.chain.receipt(s.broadcast)) === 'success') {
          this.write({ t: 'r', claimId, side, phase: 'sent', tx: s.broadcast, at: this.now() });
          continue;
        }
        if (s.since !== null) {
          const found = await this.chain.existing(agentId, doc.hash, s.since);
          if (found !== null) {
            this.write({ t: 'r', claimId, side, phase: 'sent', tx: found.txHash, at: this.now() });
            continue;
          }
        }
        this.write({ t: 'r', claimId, side, phase: 'intent', at: this.now() });
        const { txHash } = await this.chain.send(args, (tx) => this.write({ t: 'r', claimId, side, phase: 'broadcast', tx, at: this.now() }));
        this.write({ t: 'r', claimId, side, phase: 'sent', tx: txHash, at: this.now() });
      } catch (error) {
        const msg = error instanceof Error ? error.message.slice(0, 160) : 'error';
        this.log.warn('review_failed', { claimId, side, error: msg });
        this.write({ t: 'r', claimId, side, phase: 'failed', error: msg, retryAt: this.now() + this.cfg.retrySeconds, at: this.now() });
      }
    }
  }
}
