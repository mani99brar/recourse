// Per-claim records built from chain events. Each event is journaled (with its payload bytes),
// then applied; keeper-side changes (tries, holds, evidence, one-shot markers) are journaled as a
// full snapshot of the claim. Replay applies the same records in the same order, so a crash
// between an event and its snapshot loses nothing. The phase is derived from the facts, which
// keeps it right when the two chains' events arrive out of order.

import { externalIdUint } from '@recourse/shared';
import type { Address, Hex } from 'viem';
import type { Journal, JournalRecord, JsonValue } from './journal.js';
import { eventKey, newClaim, TERMINAL, type ChainEvent, type CourtAttempt, type KeeperClaim, type Phase } from './types.js';

const ZERO32 = `0x${'0'.repeat(64)}`;

function hex(v: unknown): Hex {
  return String(v).toLowerCase() as Hex;
}

function num(v: unknown): number {
  return Number(v as bigint | number);
}

/** The current court attempt (highest number), if any. */
export function currentAttempt(c: KeeperClaim): CourtAttempt | undefined {
  let best: CourtAttempt | undefined;
  for (const a of c.attempts) if (best === undefined || a.attempt > best.attempt) best = a;
  return best;
}

export function phaseOf(c: KeeperClaim): Phase {
  if (c.terminal) return c.terminal;
  if (c.rulingReceivedAt !== undefined) return 'RuledHedera';
  if (c.inbound.length > 0) return 'Relayed';
  if (c.rulingFinal) return 'RuledArb';
  if (c.staleAt !== undefined) return 'Stale';
  const cur = currentAttempt(c);
  if (c.refileNeededAt !== undefined && (cur === undefined || cur.attempt < 2)) return 'RefilePending';
  if (cur) return cur.evidenceAt !== undefined ? 'Watching' : 'Opened';
  if (c.deliveredAt !== undefined) return 'Delivered';
  if (c.outbound.length > 0) return 'Sent';
  if (c.contestedAt !== undefined) return 'Contested';
  if (c.preCheckedAt !== undefined) return 'PreChecked';
  return 'Filed';
}

export function isTerminal(c: KeeperClaim): boolean {
  return TERMINAL.includes(phaseOf(c));
}

/** Chain time the current phase was entered: each row's clock runs from this. */
export function milestoneOf(c: KeeperClaim): number | undefined {
  const p = phaseOf(c);
  switch (p) {
    case 'Filed':
      return c.filedAt;
    case 'PreChecked':
      return c.preCheckedAt;
    case 'Contested':
      return c.contestedAt;
    case 'Sent':
      return c.outbound.at(-1)?.sentAt;
    case 'Delivered':
      return c.deliveredAt;
    case 'Opened':
    case 'Watching':
      return currentAttempt(c)?.openedAt;
    case 'RefilePending':
      return c.refileNeededAt;
    case 'RuledArb':
      return c.rulingFinal?.at;
    case 'Relayed':
      return c.inbound.at(-1)?.sentAt;
    case 'RuledHedera':
      return c.rulingReceivedAt;
    case 'Stale':
      return c.staleAt;
    default:
      return c.terminalAt;
  }
}

/** Claim id an event belongs to, when the event names one. */
export function claimIdOfEvent(e: ChainEvent): Hex | undefined {
  const id = e.args.claimId ?? e.args.claimIdOrZero;
  if (typeof id !== 'string' || id === ZERO32) return undefined;
  return hex(id);
}

export interface ApplyContext {
  caseAddress: Address;
  arbChainId: number;
  opsArb: Address;
  /** Claim of an Arbitrum dispute id or external id (for Kleros events). */
  claimOfDispute: (disputeId: string) => Hex | undefined;
  claimOfExternalId: (externalId: string) => { claimId: Hex; attempt: number } | undefined;
}

/** Applies one event to the claim it belongs to. Returns the claim id it changed, if any. */
export function applyEvent(book: Map<string, KeeperClaim>, e: ChainEvent, ctx: ApplyContext): Hex | undefined {
  const a = e.args;
  const get = (id: Hex): KeeperClaim => {
    let c = book.get(id);
    if (!c) {
      c = newClaim(id);
      book.set(id, c);
    }
    return c;
  };
  if (e.source === 'claims') {
    const id = claimIdOfEvent(e);
    if (id === undefined) return undefined;
    const c = get(id);
    switch (e.name) {
      case 'ClaimFiled':
        c.orderId = hex(a.orderId);
        c.shop = a.shop as Address;
        c.platform = a.platform as Address;
        c.filedAt = num(a.filedAt);
        break;
      case 'PreCheckRecorded':
        c.preCheckedAt ??= e.time;
        break;
      case 'Contested':
        c.contestedAt ??= e.time;
        break;
      case 'ClosedUncontested':
        c.terminal = 'Closed';
        c.terminalAt = e.time;
        break;
      case 'SentToCourt': {
        const messageId = hex(a.messageId);
        if (!c.outbound.some((m) => m.messageId === messageId)) {
          c.outbound.push({ messageId, sendNo: c.outbound.length + 1, sentAt: e.time });
        }
        break;
      }
      case 'RulingReceived':
        c.rulingReceivedAt ??= e.time;
        break;
      case 'RulingIgnored':
        (c.rulingIgnored ??= []).push({ reason: num(a.reason), at: e.time });
        break;
      case 'Settled':
        c.terminal = 'Settled';
        c.terminalAt = e.time;
        break;
      case 'ClaimExpired':
        c.terminal = 'Expired';
        c.terminalAt = e.time;
        break;
      default:
        return undefined;
    }
    return id;
  }
  if (e.source === 'case') {
    const id = claimIdOfEvent(e);
    if (id === undefined) return undefined;
    const c = get(id);
    switch (e.name) {
      case 'ClaimReceived': {
        const messageId = hex(a.messageId);
        c.received ??= { messageId, payload: hex(a.payload), at: e.time };
        if (messageId === ZERO32) c.deliveredAt ??= e.time;
        break;
      }
      case 'ClaimStale':
        c.staleAt ??= e.time;
        break;
      case 'CaseOpened': {
        const attempt = num(a.attempt) as 1 | 2;
        if (!c.attempts.some((x) => x.attempt === attempt)) {
          c.attempts.push({
            attempt,
            disputeId: String(a.disputeId),
            externalId: externalIdUint(ctx.arbChainId, ctx.caseAddress, id, attempt).toString(),
            openedAt: e.time,
          });
        }
        break;
      }
      case 'RefileNeeded':
        c.refileNeededAt ??= e.time;
        break;
      case 'RulingFinal':
        c.rulingFinal ??= { disputeId: String(a.disputeId), ruling: num(a.ruling), attempts: num(a.attempts), at: e.time };
        break;
      case 'RulingRelayed': {
        const messageId = hex(a.messageId);
        if (!c.inbound.some((m) => m.messageId === messageId)) {
          c.inbound.push({ messageId, sendNo: c.inbound.length + 1, sentAt: e.time });
        }
        break;
      }
      default:
        return undefined;
    }
    return id;
  }
  if (e.source === 'core' && e.name === 'Draw') {
    const id = ctx.claimOfDispute(String(a._disputeID));
    if (id === undefined) return undefined;
    const att = book.get(id)?.attempts.find((x) => x.disputeId === String(a._disputeID));
    if (att) att.drawSeen = true;
    return id;
  }
  if (e.source === 'evidence' && e.name === 'Evidence') {
    const hit = ctx.claimOfExternalId(String(a._externalDisputeID));
    if (hit === undefined) return undefined;
    if (String(a._party).toLowerCase() !== ctx.opsArb.toLowerCase()) return undefined;
    const att = book.get(hit.claimId)?.attempts.find((x) => x.attempt === hit.attempt);
    if (att && att.evidenceAt === undefined) {
      att.evidenceAt = e.time;
      att.evidenceTx = e.tx;
    }
    return hit.claimId;
  }
  return undefined;
}

/** Event as stored in the journal: viem values made JSON-safe. */
export function eventToRecord(e: ChainEvent): JournalRecord {
  const args: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(e.args)) args[k] = jsonSafe(v) as JsonValue;
  return { t: 'event', key: eventKey(e), chain: e.chain, source: e.source, name: e.name, tx: e.tx, logIndex: e.logIndex, time: e.time, position: e.position, args };
}

function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === 'object' && v !== null) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = jsonSafe(x);
    return o;
  }
  return v;
}

export function recordToEvent(r: JournalRecord): ChainEvent {
  return {
    chain: r.chain as ChainEvent['chain'],
    source: String(r.source),
    name: String(r.name),
    args: (r.args ?? {}) as Record<string, unknown>,
    tx: String(r.tx) as Hex,
    logIndex: Number(r.logIndex),
    time: Number(r.time),
    position: String(r.position),
  };
}

/** All claims plus the indexes the machine needs, kept in step with the journal. */
export class ClaimBook {
  readonly claims = new Map<string, KeeperClaim>();
  readonly seen = new Set<string>();
  /** Bridge-wide notes the machine reacts to (ClaimRejected, contributions, mode changes). */
  readonly globalEvents: ChainEvent[] = [];

  constructor(
    private readonly journal: Journal | undefined,
    private readonly ctx: Omit<ApplyContext, 'claimOfDispute' | 'claimOfExternalId'>,
  ) {}

  private applyCtx(): ApplyContext {
    return { ...this.ctx, claimOfDispute: (d) => this.claimOfDispute(d), claimOfExternalId: (x) => this.claimOfExternalId(x) };
  }

  claimOfDispute(disputeId: string): Hex | undefined {
    for (const c of this.claims.values()) if (c.attempts.some((a) => a.disputeId === disputeId)) return c.claimId;
    return undefined;
  }

  claimOfExternalId(externalId: string): { claimId: Hex; attempt: number } | undefined {
    for (const c of this.claims.values()) {
      for (const a of c.attempts) if (a.externalId === externalId) return { claimId: c.claimId, attempt: a.attempt };
    }
    return undefined;
  }

  /** Our dispute ids (for the Kleros log filters). */
  disputeIds(): bigint[] {
    const out: bigint[] = [];
    for (const c of this.claims.values()) for (const a of c.attempts) out.push(BigInt(a.disputeId));
    return out;
  }

  externalIds(): bigint[] {
    const out: bigint[] = [];
    for (const c of this.claims.values()) for (const a of c.attempts) out.push(BigInt(a.externalId));
    return out;
  }

  /** Journals and applies a new event. Returns false for an event already seen. */
  ingest(e: ChainEvent): { fresh: boolean; claimId?: Hex } {
    const key = eventKey(e);
    if (this.seen.has(key)) return { fresh: false };
    this.journal?.append(eventToRecord(e));
    this.seen.add(key);
    const claimId = applyEvent(this.claims, e, this.applyCtx());
    if (claimId === undefined) this.globalEvents.push(e);
    return { fresh: true, claimId };
  }

  /** Journals a full snapshot of the claim after a keeper-side change. */
  save(c: KeeperClaim): void {
    this.journal?.append({ t: 'state', claimId: c.claimId, phase: phaseOf(c), claim: JSON.parse(JSON.stringify(c)) });
  }

  /** Rebuilds from replayed records. Terminal claims come back as they were and are never re-checked. */
  load(records: readonly JournalRecord[]): void {
    for (const r of records) {
      if (r.t === 'event') {
        const e = recordToEvent(r);
        const key = String(r.key);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (applyEvent(this.claims, e, this.applyCtx()) === undefined) this.globalEvents.push(e);
      } else if (r.t === 'state' && typeof r.claimId === 'string' && r.claim) {
        this.claims.set(r.claimId, r.claim as unknown as KeeperClaim);
      }
    }
  }

  /** Terminal claims first, then open ones (the order the machine resumes them in). */
  ordered(): KeeperClaim[] {
    const all = [...this.claims.values()];
    return [...all.filter(isTerminal), ...all.filter((c) => !isTerminal(c))];
  }

  open(): KeeperClaim[] {
    return [...this.claims.values()].filter((c) => !isTerminal(c));
  }
}
