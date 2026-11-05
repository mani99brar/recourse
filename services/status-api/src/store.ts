// In-memory state: the event set, the HCS records, three cursors and the last live reads. Every
// derived value is computed from this state on demand, so replaying an input changes nothing and
// a full rebuild gives the same answers as an incremental run.

import type { Hex } from 'viem';
import { compareEvents } from './decode.js';
import { snapshotReplacer, snapshotReviver } from './json.js';
import type { HcsRecord, IndexedEvent, SourceName, SourceStatus } from './types.js';

export interface HederaCursor {
  /** Mirror consensus timestamp `sec.nanos` of the last row applied. */
  timestamp: string;
  /** Log index of that row. */
  index: number;
}

export interface Cursors {
  /** Per contract address (lower case). */
  hedera: Record<string, HederaCursor>;
  arbitrum: { block: bigint | null };
  hcs: { seq: number };
}

export interface RawCaseView {
  state: number;
  payloadHash: Hex;
  receivedAt: bigint;
  attempts: number;
  disputeIds: readonly [bigint, bigint];
  templateIds: readonly [bigint, bigint];
  ruling: number;
  ruledAt: bigint;
  sendCount: number;
  lastSendAt: bigint;
  lastMessageId: Hex;
}

export interface KlerosRead {
  period: number;
  currentRuling: bigint;
  tied: boolean;
  overridden: boolean;
}

export interface LiveState {
  caseView: RawCaseView | null;
  /** CCIP execution state by message id. */
  exec: Record<string, number>;
  /** By dispute id (decimal text). */
  kleros: Record<string, KlerosRead>;
  at: number;
}

export interface EvidenceItem {
  externalId: string;
  party: string;
  uri: string;
  tx: Hex;
  logIndex: number;
  time: bigint;
}

function emptyStatus(): SourceStatus {
  return {
    cursor: '',
    indexedThrough: null,
    headDistance: null,
    lastError: null,
    lastErrorAt: null,
    lastOkAt: null,
    failing: false,
    decodeFailures: 0,
  };
}

export class Store {
  events = new Map<string, IndexedEvent>();
  hcs = new Map<string, HcsRecord>();
  cursors: Cursors = { hedera: {}, arbitrum: { block: null }, hcs: { seq: 0 } };
  live = new Map<string, LiveState>();
  evidence = new Map<string, EvidenceItem>();
  /** Per external id: last Arbitrum block read for evidence. */
  evidenceCursor: Record<string, bigint> = {};
  status: Record<SourceName, SourceStatus> = { hedera: emptyStatus(), arbitrum: emptyStatus(), hcs: emptyStatus() };
  rebuilding = false;
  /** Newest Arbitrum block at the finalized tag, when known. */
  arbFinalized: bigint | null = null;

  private dirty = true;
  private idx = {
    sorted: [] as IndexedEvent[],
    byClaim: new Map<string, IndexedEvent[]>(),
    disputeToClaim: new Map<string, string>(),
  };

  /** Adds events; returns how many were new. */
  addEvents(list: readonly IndexedEvent[]): number {
    let added = 0;
    for (const e of list) {
      if (this.events.has(e.key)) continue;
      this.events.set(e.key, e);
      added++;
    }
    if (added > 0) this.dirty = true;
    return added;
  }

  addHcs(list: readonly HcsRecord[]): number {
    let added = 0;
    for (const r of list) {
      const k = `${r.topic}:${r.seq}`;
      if (this.hcs.has(k)) continue;
      this.hcs.set(k, r);
      added++;
    }
    return added;
  }

  addEvidence(list: readonly EvidenceItem[]): void {
    for (const e of list) this.evidence.set(`${e.tx}:${e.logIndex}`, e);
  }

  private reindex(): void {
    if (!this.dirty) return;
    const sorted = [...this.events.values()].sort(compareEvents);
    const disputeToClaim = new Map<string, string>();
    for (const e of sorted) {
      if (e.contract === 'case' && e.name === 'CaseOpened') {
        disputeToClaim.set(String(e.args.disputeId), String(e.args.claimId));
      }
    }
    const byClaim = new Map<string, IndexedEvent[]>();
    for (const e of sorted) {
      const id = claimIdOfEvent(e, disputeToClaim);
      if (id === null) continue;
      const list = byClaim.get(id);
      if (list) list.push(e);
      else byClaim.set(id, [e]);
    }
    this.idx = { sorted, byClaim, disputeToClaim };
    this.dirty = false;
  }

  allEvents(): readonly IndexedEvent[] {
    this.reindex();
    return this.idx.sorted;
  }

  eventsOf(claimId: string): readonly IndexedEvent[] {
    this.reindex();
    return this.idx.byClaim.get(claimId) ?? [];
  }

  claimIds(): string[] {
    this.reindex();
    return [...this.idx.byClaim.keys()].filter((id) => this.eventsOf(id).some((e) => e.name === 'ClaimFiled'));
  }

  claimOfDispute(disputeId: bigint | string): string | undefined {
    this.reindex();
    return this.idx.disputeToClaim.get(String(disputeId));
  }

  toJSON(): string {
    return JSON.stringify(
      {
        v: 1,
        events: [...this.events.values()],
        hcs: [...this.hcs.values()],
        cursors: this.cursors,
        live: [...this.live.entries()],
        evidence: [...this.evidence.values()],
        evidenceCursor: this.evidenceCursor,
      },
      snapshotReplacer,
    );
  }

  /** Loads a snapshot; returns false (and leaves the store untouched) when it cannot be read. */
  static fromJSON(text: string): Store | null {
    try {
      const o = JSON.parse(text, snapshotReviver) as {
        v: number;
        events: IndexedEvent[];
        hcs: HcsRecord[];
        cursors: Cursors;
        live: [string, LiveState][];
        evidence: EvidenceItem[];
        evidenceCursor: Record<string, bigint>;
      };
      if (o.v !== 1 || !Array.isArray(o.events) || !Array.isArray(o.hcs)) return null;
      const s = new Store();
      s.addEvents(o.events);
      s.addHcs(o.hcs);
      s.cursors = o.cursors;
      s.live = new Map(o.live);
      s.addEvidence(o.evidence);
      s.evidenceCursor = o.evidenceCursor;
      return s;
    } catch {
      return null;
    }
  }
}

const ZERO32 = '0x' + '00'.repeat(32);

/** The claim an event belongs to, or null for events that belong to no claim. */
export function claimIdOfEvent(e: IndexedEvent, disputeToClaim: ReadonlyMap<string, string>): string | null {
  const a = e.args;
  if (typeof a.claimId === 'string') return a.claimId;
  if (typeof a.claimIdOrZero === 'string' && a.claimIdOrZero !== ZERO32) return a.claimIdOrZero;
  if (e.contract === 'case') {
    if (e.name === 'DisputeRequest') return disputeToClaim.get(String(a._arbitratorDisputeID)) ?? null;
    if (e.name === 'Ruling') return disputeToClaim.get(String(a._disputeID)) ?? null;
    if (e.name === 'RuleIgnored') return disputeToClaim.get(String(a.disputeId)) ?? null;
  }
  return null;
}
