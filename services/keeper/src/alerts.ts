// Alerts to the operator, sent without any model in the loop: an HTTP POST of JSON to ALERT_URL.
// Each (claim, kind) goes out at most once per dedupe window. Every alert is journaled first, so
// when the endpoint is down the alert waits in the journal and is sent on a later flush.

import type { Hex } from 'viem';
import type { JournalRecord } from './journal.js';
import { PermanentError, TransientError, postJson, type FetchLike } from './net.js';

export const ALERT_KINDS = [
  // stalls
  'precheck_late',
  'close_late',
  'send_late',
  'outbound_slow',
  'open_late',
  'evidence_late',
  'evidence_missed',
  'juror_absent',
  'ruling_slow',
  'refile_late',
  'relay_late',
  'return_slow',
  'settle_late',
  'settle_failed',
  // events and limits
  'exec_failure',
  'delivered_not_recorded',
  'sends_exhausted',
  'ruling_zero_early',
  'expiry_race',
  'expire_failed',
  'claim_stale',
  'one_leg_manual',
  'evidence_hash_mismatch',
  'evidence_too_large',
  'evidence_failed',
  'withdraw_due',
  'kleros_nudged',
  'precheck_conflict',
  'precheck_stalled',
  'appeal_contribution',
  'fee_pool_low',
  'link_low',
  'gas_low',
  'open_cases_near_cap',
  'rpc_down',
  'mirror_lag',
  'journal_error',
  'params_unreadable',
  'call_failed',
  'claim_held',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface Alert {
  kind: AlertKind;
  claimId?: Hex;
  /**
   * What a claim-less alert is about (a key, a contract), so two of one kind (ops-hedera and
   * ops-arb short of gas, say) are deduped apart.
   */
  subject?: string;
  /** Keeper state of the claim when the alert fired. */
  state?: string;
  /** Explorer, court or CCIP links. */
  links?: string[];
  /** What the operator should look at or do next. */
  hint?: string;
  /** Short facts (amounts, ids, reasons), all strings. */
  detail?: Record<string, string>;
}

export interface AlertRecord extends JournalRecord {
  t: 'alert';
  id: string;
  service: string;
  kind: AlertKind;
  claimId?: Hex;
  subject?: string;
  state?: string;
  links?: string[];
  hint?: string;
  detail?: Record<string, string>;
  /** Unix ms when raised. */
  raisedAt: number;
}

export interface AlerterOptions {
  service: string;
  /** No URL: alerts are journaled and logged only. */
  url?: string;
  append: (record: JournalRecord) => void;
  now?: () => number;
  dedupeMs?: number;
  fetch?: FetchLike;
  log?: (line: string) => void;
}

/**
 * Why a post failed, without the URL: ALERT_URL may carry a token in its path (a chat bot's
 * webhook), and this text goes to the log, the journal and /health.
 */
function deliveryError(err: unknown): string {
  if ((err instanceof TransientError || err instanceof PermanentError) && err.status !== undefined) return `HTTP ${err.status}`;
  if (err instanceof TransientError) return err.message.startsWith('timeout') ? 'timeout' : 'network error';
  return 'post failed';
}

/** Alerts that wait to be sent, for /health. */
export interface AlertBacklog {
  count: number;
  /** Age of the oldest unsent alert in ms (the alerter's clock); absent when none waits. */
  oldestAgeMs?: number;
  /** Whether an endpoint (ALERT_URL) is configured at all. */
  configured: boolean;
  /** Why the last flush sent nothing, while the endpoint has taken nothing since. */
  lastError?: string;
}

function dedupeKey(kind: string, claimId: string | undefined, subject?: string): string {
  return `${claimId ?? (subject ? `@${subject}` : '-')}|${kind}`;
}

/** Unsent alerts kept at most; past this the oldest unsent one is dropped (it stays in the log). */
export const OUTBOX_MAX = 500;

interface Clock {
  kind: AlertKind;
  claimId?: Hex;
  subject?: string;
  at: number;
}

export class Alerter {
  private readonly last = new Map<string, Clock>();
  private readonly outbox = new Map<string, AlertRecord>();
  private counter = 0;
  /** Why the last flush could not deliver, until the endpoint takes an alert again. */
  private lastError?: string;
  private toldUnset = false;

  constructor(private readonly o: AlerterOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private tick(kind: AlertKind, claimId: Hex | undefined, subject: string | undefined, at: number): void {
    const key = dedupeKey(kind, claimId, subject);
    const prev = this.last.get(key);
    if (prev !== undefined && prev.at >= at) return;
    this.last.set(key, { kind, ...(claimId ? { claimId } : {}), ...(subject ? { subject } : {}), at });
  }

  private queue(rec: AlertRecord): void {
    this.outbox.set(rec.id, rec);
    while (this.outbox.size > OUTBOX_MAX) {
      const oldest = this.outbox.keys().next().value as string;
      this.outbox.delete(oldest);
    }
  }

  /** Rebuilds the dedupe clock and the unsent outbox from a replayed journal. */
  load(records: readonly JournalRecord[]): void {
    for (const r of records) this.loadRecord(r);
  }

  /** One replayed record, in journal order (an alertSent always follows its alert). */
  loadRecord(r: JournalRecord): void {
    if (r.t === 'alert') {
      const a = r as AlertRecord;
      this.tick(a.kind, a.claimId, a.subject, a.raisedAt);
      this.queue(a);
    } else if (r.t === 'alertSent') {
      this.outbox.delete(String(r.id));
    } else if (r.t === 'alertClock' && typeof r.kind === 'string' && typeof r.raisedAt === 'number') {
      this.tick(r.kind as AlertKind, typeof r.claimId === 'string' ? (r.claimId as Hex) : undefined, typeof r.subject === 'string' ? r.subject : undefined, r.raisedAt);
    }
  }

  /** The alerter's state as journal records: one clock per (claim or subject, kind), then the unsent alerts. */
  compact(): JournalRecord[] {
    const out: JournalRecord[] = [];
    for (const c of this.last.values()) {
      out.push({ t: 'alertClock', kind: c.kind, raisedAt: c.at, ...(c.claimId ? { claimId: c.claimId } : {}), ...(c.subject ? { subject: c.subject } : {}) });
    }
    for (const rec of this.outbox.values()) out.push(rec);
    return out;
  }

  /** Last time this (claim, kind) was raised, in unix ms. */
  lastRaised(kind: AlertKind, claimId?: Hex): number | undefined {
    return this.last.get(dedupeKey(kind, claimId))?.at;
  }

  /** The most recent alert raised for a claim, sent or not. */
  latestFor(claimId: Hex): { kind: AlertKind; raisedAt: number } | undefined {
    const id = claimId.toLowerCase();
    let best: { kind: AlertKind; raisedAt: number } | undefined;
    for (const c of this.last.values()) {
      if (c.claimId?.toLowerCase() !== id) continue;
      if (best === undefined || c.at > best.raisedAt) best = { kind: c.kind, raisedAt: c.at };
    }
    return best;
  }

  /** Raises an alert unless the same (claim, kind) was raised inside the dedupe window. */
  raise(alert: Alert): boolean {
    const now = this.now();
    const key = dedupeKey(alert.kind, alert.claimId, alert.subject);
    const prev = this.last.get(key)?.at;
    if (prev !== undefined && now - prev < (this.o.dedupeMs ?? 30 * 60_000)) return false;
    this.counter += 1;
    const rec: AlertRecord = {
      t: 'alert',
      id: `${this.o.service}-${now.toString(36)}-${this.counter.toString(36)}`,
      service: this.o.service,
      raisedAt: now,
      ...alert,
    };
    this.o.append(rec);
    this.tick(alert.kind, alert.claimId, alert.subject, now);
    this.queue(rec);
    this.o.log?.(`alert ${alert.kind}${alert.claimId ? ` ${alert.claimId}` : ''}${alert.hint ? `: ${alert.hint}` : ''}`);
    return true;
  }

  pending(): AlertRecord[] {
    return [...this.outbox.values()];
  }

  /** Whether alerts can leave this process: false without ALERT_URL (journaled and logged only). */
  get configured(): boolean {
    return this.o.url !== undefined && this.o.url !== '';
  }

  /** What waits to be sent: how many, the oldest's age, and why (no URL, or the endpoint's answer). */
  backlog(): AlertBacklog {
    let oldest: number | undefined;
    for (const r of this.outbox.values()) if (oldest === undefined || r.raisedAt < oldest) oldest = r.raisedAt;
    return {
      count: this.outbox.size,
      ...(oldest !== undefined ? { oldestAgeMs: Math.max(0, this.now() - oldest) } : {}),
      configured: this.configured,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  /** Logs a delivery failure when it is new, not on every flush. */
  private failed(error: string): void {
    if (this.lastError !== error) this.o.log?.(`alerts not delivered: the endpoint answers ${error}; ${this.outbox.size} waiting`);
    this.lastError = error;
  }

  /**
   * Sends what is waiting, oldest first. An endpoint that is down (network error, timeout, 429,
   * 5xx) stops the flush and everything stays queued in order. One the endpoint refuses for good
   * (another 4xx) is passed over, so it never holds back the alerts behind it; once the endpoint
   * has taken another alert in the same flush, the refused one is journaled as dropped and
   * leaves the outbox. While nothing is taken (a wrong URL refuses everything) all stay queued.
   */
  async flush(): Promise<{ sent: number; failed: number; dropped?: number }> {
    let sent = 0;
    let failed = 0;
    if (this.o.url === undefined || this.o.url === '') {
      if (this.outbox.size > 0 && !this.toldUnset) {
        this.toldUnset = true;
        this.o.log?.('ALERT_URL is not set: alerts go to this log only, as its "alert ..." lines');
      }
      return { sent, failed: this.outbox.size };
    }
    const refused: { rec: AlertRecord; error: string }[] = [];
    let down: string | undefined;
    for (const rec of [...this.outbox.values()]) {
      const body = {
        service: rec.service,
        kind: rec.kind,
        claimId: rec.claimId ?? null,
        state: rec.state ?? null,
        links: rec.links ?? [],
        hint: rec.hint ?? null,
        detail: rec.detail ?? {},
        raisedAt: new Date(rec.raisedAt).toISOString(),
      };
      try {
        await postJson(this.o.url, body, { fetch: this.o.fetch, timeoutMs: 10_000 });
        this.o.append({ t: 'alertSent', id: rec.id });
        this.outbox.delete(rec.id);
        sent += 1;
        this.lastError = undefined;
      } catch (err) {
        failed += 1;
        if (err instanceof PermanentError) {
          refused.push({ rec, error: deliveryError(err) });
          continue; // this payload is refused, not the endpoint down: go on to the next
        }
        down = deliveryError(err);
        break; // endpoint down: keep order, try again next flush
      }
    }
    if (sent === 0) {
      const why = down ?? refused[0]?.error;
      if (why !== undefined) this.failed(why);
    }
    let dropped = 0;
    if (sent > 0) {
      for (const { rec, error } of refused) {
        this.o.append({ t: 'alertSent', id: rec.id, dropped: error });
        this.outbox.delete(rec.id);
        this.o.log?.(`alert ${rec.kind}${rec.claimId ? ` ${rec.claimId}` : ''} dropped: the endpoint refused it (${error}); it stays in the journal as ${rec.id}`);
        dropped += 1;
      }
    }
    return dropped > 0 ? { sent, failed, dropped } : { sent, failed };
  }
}
