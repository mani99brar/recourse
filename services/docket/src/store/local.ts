// Local store: the same rows and keys as Arkiv, kept in a JSONL file under the docket state dir.
// Every write appends a full-row snapshot (fsynced); opening replays them. Entity keys are
// `local:<claimId>` for cases and `local:count:<month>:<platform>:<shop>` for counts.

import { Journal, readJournal } from '@recourse/records';
import type { Address } from 'viem';
import { countKey, type CaseRow, type CountRow } from '../schema.js';
import type { CaseQuery, DocketStore, Stored, TxState, WriteReceipt } from './types.js';

interface LocalRow {
  t: 'case' | 'count';
  entityKey: string;
  row: CaseRow | CountRow;
}

export class LocalStore implements DocketStore {
  readonly kind = 'local' as const;
  private readonly cases = new Map<string, Stored<CaseRow>>();
  private readonly counts = new Map<string, Stored<CountRow>>();

  constructor(private readonly journal: Journal<LocalRow>) {
    for (const r of readJournal<LocalRow>(journal.path).rows) this.apply(r);
  }

  static open(path: string): LocalStore {
    return new LocalStore(Journal.open<LocalRow>(path));
  }

  private apply(r: LocalRow): void {
    if (r.t === 'case') this.cases.set((r.row as CaseRow).claimId, { entityKey: r.entityKey, row: r.row as CaseRow });
    else this.counts.set(countKey(r.row as CountRow), { entityKey: r.entityKey, row: r.row as CountRow });
  }

  private put(r: LocalRow): void {
    this.journal.append(r);
    this.apply(r);
  }

  async createCase(row: CaseRow): Promise<WriteReceipt> {
    const entityKey = `local:${row.claimId}`;
    this.put({ t: 'case', entityKey, row });
    return { entityKey };
  }

  async patchCase(entityKey: string, set: Partial<CaseRow>): Promise<{ txHash?: string }> {
    const current = [...this.cases.values()].find((c) => c.entityKey === entityKey);
    if (current === undefined) throw new Error(`local store: no case ${entityKey}`);
    this.put({ t: 'case', entityKey, row: { ...current.row, ...set } });
    return {};
  }

  async findCase(claimId: string): Promise<Stored<CaseRow> | null> {
    return this.cases.get(claimId.toLowerCase()) ?? null;
  }

  async listCases(query: CaseQuery = {}): Promise<Stored<CaseRow>[]> {
    return [...this.cases.values()].filter((c) => matches(c.row, query));
  }

  async createCount(row: CountRow): Promise<WriteReceipt> {
    const entityKey = `local:count:${countKey(row)}`;
    this.put({ t: 'count', entityKey, row });
    return { entityKey };
  }

  async patchCount(entityKey: string, set: Partial<CountRow>): Promise<{ txHash?: string }> {
    const current = [...this.counts.values()].find((c) => c.entityKey === entityKey);
    if (current === undefined) throw new Error(`local store: no count ${entityKey}`);
    this.put({ t: 'count', entityKey, row: { ...current.row, ...set } });
    return {};
  }

  async findCount(key: { month: string; platform: Address; shop: Address }): Promise<Stored<CountRow> | null> {
    return this.counts.get(countKey(key)) ?? null;
  }

  async listCounts(query: CaseQuery = {}): Promise<Stored<CountRow>[]> {
    return [...this.counts.values()].filter((c) => matches(c.row, query));
  }

  async txState(_txHash: string): Promise<TxState> {
    return 'success';
  }

  close(): void {
    this.journal.close();
  }
}

function matches(row: { platform: Address; shop: Address; month: string }, q: CaseQuery): boolean {
  if (q.platform !== undefined && row.platform.toLowerCase() !== q.platform.toLowerCase()) return false;
  if (q.shop !== undefined && row.shop.toLowerCase() !== q.shop.toLowerCase()) return false;
  if (q.month !== undefined && row.month !== q.month) return false;
  return true;
}
