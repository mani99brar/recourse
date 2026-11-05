// The docket engine. Chain events go in, `case` and `monthly-count` rows go out through the store,
// and every step is journaled so a restart replays, rechecks the store for writes that may have
// landed unrecorded, and never writes a second entity for the same claim.

import type { Journal, Logger } from '@recourse/records';
import type { Hex } from 'viem';
import { eventKey, type DocketEvent } from './events.js';
import { nullPinner, reasonDoc, type Pinner } from './reason.js';
import { caseRowEquals, countKey, type CaseRow, type CountRow } from './schema.js';
import { applyEvent, caseRowOf, countsOf, isCaseDue, outcomeOf, type ClaimState } from './state.js';
import { classifyError, diffCase, diffCount, type DocketStore, type StoreKind } from './store/types.js';

export type WriteStatus = 'none' | 'pending' | 'written' | 'failed';
export type ReviewState = 'cut' | 'none' | 'pending' | 'sent' | 'failed' | 'skipped';
export interface ReviewStatus {
  status: ReviewState;
  tx?: string;
}
export interface ReviewsView {
  platform: ReviewStatus;
  shop: ReviewStatus;
}

/** Sends reviews for written cases. The docket calls it after the case write and ignores its failures. */
export interface ReviewPort {
  process(cases: readonly { claimId: Hex; row: CaseRow }[]): Promise<void>;
  statusOf(claimId: Hex): ReviewsView;
}

export const cutReviews: ReviewPort = {
  process: async () => {},
  statusOf: () => ({ platform: { status: 'cut' }, shop: { status: 'cut' } }),
};

type Target = 'case' | 'count';

export type JournalRow =
  | { t: 'ev'; key: string; e: DocketEvent }
  | { t: 'cursor'; source: string; value: string }
  | { t: 'reason'; claimId: Hex; cid: string }
  | { t: 'w'; target: Target; id: string; phase: 'intent'; row: CaseRow | CountRow; at: number }
  | { t: 'w'; target: Target; id: string; phase: 'sent'; txHash?: string; entityKey?: string; at: number }
  | { t: 'w'; target: Target; id: string; phase: 'done'; entityKey: string; row: CaseRow | CountRow; at: number }
  | { t: 'w'; target: Target; id: string; phase: 'failed'; kind: string; error: string; retryAt: number; at: number };

interface WriteState {
  entityKey: string | null;
  written: CaseRow | CountRow | null;
  intent: boolean;
  intentRow: CaseRow | CountRow | null;
  txHash: string | null;
  attempts: number;
  lastError: string | null;
  errorKind: string | null;
  retryAt: number;
  alerted: boolean;
  updatedAt: number;
}

function emptyWrite(): WriteState {
  return { entityKey: null, written: null, intent: false, intentRow: null, txHash: null, attempts: 0, lastError: null, errorKind: null, retryAt: 0, alerted: false, updatedAt: 0 };
}

export interface DocketDeps {
  store: DocketStore;
  journal: Journal<JournalRow>;
  /** Existing journal rows, read before the journal was opened for append. */
  history: readonly JournalRow[];
  now: () => number;
  log: Logger;
  alert?: (text: string) => void | Promise<void>;
  pinner?: Pinner;
  reviews?: ReviewPort;
  retrySeconds?: number;
  retryMax?: number;
}

export interface WriteStatusView {
  claimId: string;
  writeStatus: WriteStatus;
  store: StoreKind;
  entityKey: string | null;
  attempts: number;
  lastError: string | null;
  errorKind: string | null;
  updatedAt: number;
  /** True while a settlement update to a written case has not landed. */
  settlementPending: boolean;
  reviews: ReviewsView;
}

export class Docket {
  readonly claims = new Map<Hex, ClaimState>();
  private readonly seen = new Set<string>();
  private readonly cursors = new Map<string, string>();
  private readonly reasons = new Map<Hex, string>();
  private readonly caseWrites = new Map<Hex, WriteState>();
  private readonly countWrites = new Map<string, WriteState>();
  private readonly retrySeconds: number;
  private readonly retryMax: number;
  private readonly pinner: Pinner;
  private readonly reviews: ReviewPort;
  private lastEventAt = 0;

  constructor(private readonly deps: DocketDeps) {
    this.retrySeconds = deps.retrySeconds ?? 600;
    this.retryMax = deps.retryMax ?? 5;
    this.pinner = deps.pinner ?? nullPinner;
    this.reviews = deps.reviews ?? cutReviews;
    for (const row of deps.history) this.replay(row);
  }

  // ------------------------------------------------------------------ replay and intake

  private writeOf(target: Target, id: string): WriteState {
    const map = target === 'case' ? this.caseWrites : this.countWrites;
    let w = map.get(id as Hex);
    if (w === undefined) {
      w = emptyWrite();
      map.set(id as Hex, w);
    }
    return w;
  }

  private replay(row: JournalRow): void {
    switch (row.t) {
      case 'ev':
        this.seen.add(row.key);
        applyEvent(this.claims, row.e);
        this.lastEventAt = Math.max(this.lastEventAt, row.e.ts);
        break;
      case 'cursor':
        this.cursors.set(row.source, row.value);
        break;
      case 'reason':
        this.reasons.set(row.claimId, row.cid);
        break;
      case 'w': {
        const w = this.writeOf(row.target, row.id);
        w.updatedAt = row.at;
        if (row.phase === 'intent') {
          w.intent = true;
          w.intentRow = row.row;
          w.txHash = null;
        } else if (row.phase === 'sent') {
          if (row.txHash !== undefined) w.txHash = row.txHash;
        } else if (row.phase === 'done') {
          w.intent = false;
          w.entityKey = row.entityKey;
          w.written = row.row;
          w.attempts = 0;
          w.lastError = null;
          w.errorKind = null;
          w.retryAt = 0;
          w.alerted = false;
          w.txHash = null;
        } else {
          w.intent = false;
          w.attempts += 1;
          w.lastError = row.error;
          w.errorKind = row.kind;
          w.retryAt = row.retryAt;
        }
        break;
      }
    }
  }

  /** Journals and applies new events; events already seen are skipped. Returns how many were new. */
  ingest(events: readonly DocketEvent[]): number {
    let n = 0;
    for (const e of events) {
      const key = eventKey(e);
      if (this.seen.has(key)) continue;
      const row: JournalRow = { t: 'ev', key, e };
      this.deps.journal.append(row);
      this.replay(row);
      n += 1;
    }
    return n;
  }

  cursor(source: string): string | undefined {
    return this.cursors.get(source);
  }

  setCursor(source: string, value: string): void {
    if (this.cursors.get(source) === value) return;
    const row: JournalRow = { t: 'cursor', source, value };
    this.deps.journal.append(row);
    this.replay(row);
  }

  // ------------------------------------------------------------------ queries

  private isWritten(claimId: Hex): boolean {
    return this.caseWrites.get(claimId)?.entityKey != null;
  }

  /** Count rows as the claim set implies them now. */
  computedCounts(): Map<string, CountRow> {
    return countsOf(this.claims.values(), (id) => this.isWritten(id));
  }

  writeStatus(claimId: string): WriteStatusView | null {
    const id = claimId.toLowerCase() as Hex;
    const c = this.claims.get(id);
    if (c === undefined) return null;
    const w = this.caseWrites.get(id);
    let status: WriteStatus = 'none';
    let settlementPending = false;
    if (isCaseDue(c)) {
      if (w?.entityKey != null) {
        status = 'written';
        settlementPending = w.written !== null && !caseRowEquals(w.written as CaseRow, caseRowOf(c, this.reasons.get(id) ?? ''));
      } else if (w !== undefined && w.lastError !== null && !w.intent) status = 'failed';
      else status = 'pending';
    }
    return {
      claimId: id,
      writeStatus: status,
      store: this.deps.store.kind,
      entityKey: w?.entityKey ?? null,
      attempts: w?.attempts ?? 0,
      lastError: w?.lastError ?? null,
      errorKind: w?.errorKind ?? null,
      updatedAt: w?.updatedAt ?? this.lastEventAt,
      settlementPending,
      reviews: this.reviews.statusOf(id),
    };
  }

  /** Rows of written cases, as published. */
  writtenCases(): { claimId: Hex; entityKey: string; row: CaseRow }[] {
    const out: { claimId: Hex; entityKey: string; row: CaseRow }[] = [];
    for (const [claimId, w] of this.caseWrites) if (w.entityKey !== null && w.written !== null) out.push({ claimId, entityKey: w.entityKey, row: w.written as CaseRow });
    return out;
  }

  writtenCounts(): { entityKey: string; row: CountRow }[] {
    const out: { entityKey: string; row: CountRow }[] = [];
    for (const w of this.countWrites.values()) if (w.entityKey !== null && w.written !== null) out.push({ entityKey: w.entityKey, row: w.written as CountRow });
    return out;
  }

  /** Uncontested closures per party, for the rates to show beside the rate. */
  closedUncontestedByParty(): { platform: Record<string, number>; shop: Record<string, number> } {
    const out = { platform: {} as Record<string, number>, shop: {} as Record<string, number> };
    for (const c of this.claims.values()) {
      if (!c.filed || c.terminal !== 'closedUncontested') continue;
      const p = c.platform.toLowerCase();
      const s = c.shop.toLowerCase();
      out.platform[p] = (out.platform[p] ?? 0) + 1;
      out.shop[s] = (out.shop[s] ?? 0) + 1;
    }
    return out;
  }

  health(): { claims: number; cursors: Record<string, string>; failedWrites: number; lastEventAt: number } {
    let failed = 0;
    for (const w of [...this.caseWrites.values(), ...this.countWrites.values()]) if (w.lastError !== null && !w.intent) failed += 1;
    return { claims: this.claims.size, cursors: Object.fromEntries(this.cursors), failedWrites: failed, lastEventAt: this.lastEventAt };
  }

  // ------------------------------------------------------------------ writing

  private journalW(row: JournalRow): void {
    this.deps.journal.append(row);
    this.replay(row);
  }

  /** Settles every write that has an intent but no recorded result, by asking the store. */
  private async resolveIntents(): Promise<void> {
    for (const [target, map] of [['case', this.caseWrites], ['count', this.countWrites]] as const) {
      for (const [id, w] of map) {
        if (!w.intent) continue;
        if (w.txHash !== null && (await this.deps.store.txState(w.txHash)) === 'pending') continue; // still on its way
        const found =
          target === 'case'
            ? await this.deps.store.findCase(id)
            : await this.deps.store.findCount(parseCountKey(id));
        if (found !== null) {
          this.journalW({ t: 'w', target, id, phase: 'done', entityKey: found.entityKey, row: found.row, at: this.deps.now() });
        } else {
          // nothing landed: drop the intent so the write is planned again
          w.intent = false;
        }
      }
    }
  }

  private due(w: WriteState): boolean {
    if (w.intent) return false;
    if (w.lastError === null) return true;
    return w.attempts < this.retryMax && this.deps.now() >= w.retryAt;
  }

  /**
   * After a failed create the entity may still have landed (a lost response), so look it up by
   * owner and id before writing again; adopt what is found.
   */
  private async adoptIfLanded(target: Target, id: string, w: WriteState): Promise<void> {
    if (w.entityKey !== null || w.attempts === 0) return;
    try {
      const found = target === 'case' ? await this.deps.store.findCase(id) : await this.deps.store.findCount(parseCountKey(id));
      if (found !== null) this.journalW({ t: 'w', target, id, phase: 'done', entityKey: found.entityKey, row: found.row, at: this.deps.now() });
    } catch {
      /* the lookup failing is treated like the write failing: try again next pass */
    }
  }

  private async attempt(target: Target, id: string, w: WriteState, desired: CaseRow | CountRow): Promise<'ok' | 'failed' | 'auth'> {
    const store = this.deps.store;
    const at = this.deps.now();
    this.journalW({ t: 'w', target, id, phase: 'intent', row: desired, at });
    try {
      let entityKey = w.entityKey;
      let txHash: string | undefined;
      if (entityKey === null) {
        const r = target === 'case' ? await store.createCase(desired as CaseRow) : await store.createCount(desired as CountRow);
        entityKey = r.entityKey;
        txHash = r.txHash;
      } else {
        const prev = w.written!;
        const r =
          target === 'case'
            ? await store.patchCase(entityKey, diffCase(prev as CaseRow, desired as CaseRow))
            : await store.patchCount(entityKey, diffCount(prev as CountRow, desired as CountRow));
        txHash = r.txHash;
      }
      this.journalW({ t: 'w', target, id, phase: 'sent', ...(txHash ? { txHash } : {}), entityKey, at: this.deps.now() });
      this.journalW({ t: 'w', target, id, phase: 'done', entityKey, row: desired, at: this.deps.now() });
      return 'ok';
    } catch (error) {
      const err = classifyError(error);
      this.journalW({ t: 'w', target, id, phase: 'failed', kind: err.kind, error: err.message, retryAt: this.deps.now() + this.retrySeconds, at: this.deps.now() });
      this.deps.log.warn('write_failed', { target, id, kind: err.kind, attempts: w.attempts });
      if (w.attempts >= this.retryMax && !w.alerted) {
        w.alerted = true;
        await this.deps.alert?.(`docket: ${target} write for ${id} failed ${w.attempts} times (${err.kind}); holding as failed`);
      }
      return err.kind === 'auth' ? 'auth' : 'failed';
    }
  }

  /** One pass: settle old intents, write due cases, then counts, then reviews. */
  async flush(): Promise<{ wrote: number; failed: number }> {
    let wrote = 0;
    let failed = 0;
    await this.resolveIntents();

    const dueCases = [...this.claims.values()].filter(isCaseDue).sort((a, b) => a.ruling!.ts - b.ruling!.ts || (a.claimId < b.claimId ? -1 : 1));
    let stop = false;
    for (const c of dueCases) {
      if (stop) break;
      const w = this.writeOf('case', c.claimId);
      if (!this.due(w)) continue;
      await this.adoptIfLanded('case', c.claimId, w);
      if (!this.reasons.has(c.claimId)) await this.pinReason(c);
      const desired = caseRowOf(c, this.reasons.get(c.claimId) ?? '');
      if (w.entityKey !== null && w.written !== null && caseRowEquals(w.written as CaseRow, desired)) continue;
      const r = await this.attempt('case', c.claimId, w, desired);
      if (r === 'ok') wrote += 1;
      else failed += 1;
      if (r === 'auth') stop = true;
    }

    if (!stop) {
      for (const [key, row] of this.computedCounts()) {
        const w = this.writeOf('count', key);
        if (!this.due(w)) continue;
        await this.adoptIfLanded('count', key, w);
        if (w.entityKey !== null && w.written !== null && countEquals(w.written as CountRow, row)) continue;
        const r = await this.attempt('count', key, w, row);
        if (r === 'ok') wrote += 1;
        else failed += 1;
        if (r === 'auth') break;
      }
    }

    try {
      await this.reviews.process(this.writtenCases());
    } catch (error) {
      this.deps.log.warn('reviews_failed', { error: error instanceof Error ? error.message : String(error) });
    }
    return { wrote, failed };
  }

  private async pinReason(c: ClaimState): Promise<void> {
    const draft = caseRowOf(c);
    let cid = '';
    try {
      cid = (await this.pinner.pin(reasonDoc(draft).bytes)) ?? '';
    } catch (error) {
      this.deps.log.warn('reason_pin_failed', { claimId: c.claimId, error: error instanceof Error ? error.message : String(error) });
    }
    const row: JournalRow = { t: 'reason', claimId: c.claimId, cid };
    this.deps.journal.append(row);
    this.replay(row);
  }

  /** Rows for the rates module, from written cases. */
  rateRows(): { platform: string; shop: string; outcome: number; unresolved: boolean; inclusionBps: number }[] {
    return this.writtenCases().map(({ row }) => ({ platform: row.platform, shop: row.shop, outcome: row.outcome, unresolved: row.unresolved, inclusionBps: row.inclusionBps }));
  }

  /** Outcome of a claim as published, for tests and the review writer. */
  outcomeFor(claimId: Hex): number {
    const c = this.claims.get(claimId);
    return c === undefined ? 0 : outcomeOf(c);
  }
}

function countEquals(a: CountRow, b: CountRow): boolean {
  return countKey(a) === countKey(b) && diffCount(a, b) !== undefined && Object.keys(diffCount(a, b)).length === 0;
}

function parseCountKey(key: string): { month: string; platform: CountRow['platform']; shop: CountRow['shop'] } {
  const [month, platform, shop] = key.split('|');
  return { month: month!, platform: platform as CountRow['platform'], shop: shop as CountRow['shop'] };
}
