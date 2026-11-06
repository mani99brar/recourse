// Alerts to the operator, sent without any model in the loop: an HTTP POST of JSON to ALERT_URL.
// Each (claim, kind) goes out at most once per dedupe window. Every alert is journaled first, so
// when the endpoint is down the alert waits in the journal and is sent on a later flush.

import type { Hex } from 'viem';
import type { JournalRecord } from './journal.js';
import { postJson, type FetchLike } from './net.js';

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

function dedupeKey(kind: string, claimId: string | undefined, subject?: string): string {
  return `${claimId ?? (subject ? `@${subject}` : '-')}|${kind}`;
}

export class Alerter {
  private readonly last = new Map<string, number>();
  private readonly outbox = new Map<string, AlertRecord>();
  private counter = 0;

  constructor(private readonly o: AlerterOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Rebuilds the dedupe clock and the unsent outbox from a replayed journal. */
  load(records: readonly JournalRecord[]): void {
    const sent = new Set<string>();
    for (const r of records) if (r.t === 'alertSent') sent.add(String(r.id));
    for (const r of records) {
      if (r.t !== 'alert') continue;
      const a = r as AlertRecord;
      this.last.set(dedupeKey(a.kind, a.claimId, a.subject), a.raisedAt);
      if (!sent.has(a.id)) this.outbox.set(a.id, a);
    }
  }

  /** Last time this (claim, kind) was raised, in unix ms. */
  lastRaised(kind: AlertKind, claimId?: Hex): number | undefined {
    return this.last.get(dedupeKey(kind, claimId));
  }

  /** The most recent alert raised for a claim, sent or not. */
  latestFor(claimId: Hex): { kind: AlertKind; raisedAt: number } | undefined {
    const prefix = `${claimId.toLowerCase()}|`;
    let best: { kind: AlertKind; raisedAt: number } | undefined;
    for (const [key, at] of this.last) {
      if (!key.startsWith(prefix)) continue;
      if (best === undefined || at > best.raisedAt) best = { kind: key.slice(prefix.length) as AlertKind, raisedAt: at };
    }
    return best;
  }

  /** Raises an alert unless the same (claim, kind) was raised inside the dedupe window. */
  raise(alert: Alert): boolean {
    const now = this.now();
    const key = dedupeKey(alert.kind, alert.claimId, alert.subject);
    const prev = this.last.get(key);
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
    this.last.set(key, now);
    this.outbox.set(rec.id, rec);
    this.o.log?.(`alert ${alert.kind}${alert.claimId ? ` ${alert.claimId}` : ''}${alert.hint ? `: ${alert.hint}` : ''}`);
    return true;
  }

  pending(): AlertRecord[] {
    return [...this.outbox.values()];
  }

  /** Sends what is waiting. Failures stay queued for the next flush. */
  async flush(): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    if (this.o.url === undefined || this.o.url === '') return { sent, failed: this.outbox.size };
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
      } catch {
        failed += 1;
        break; // endpoint down: keep order, try again next flush
      }
    }
    return { sent, failed };
  }
}
