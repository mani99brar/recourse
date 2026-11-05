// The docket writes through one port, so the Arkiv store and the local store give the same rows,
// the same keys and the same write status.

import type { Address } from 'viem';
import { CASE_ATTRS, COUNT_ATTRS, type CaseRow, type CountRow } from '../schema.js';

export type StoreKind = 'arkiv' | 'local';
export type TxState = 'pending' | 'success' | 'failed' | 'unknown';

export interface Stored<Row> {
  entityKey: string;
  row: Row;
}

export interface WriteReceipt {
  entityKey: string;
  txHash?: string;
}

export interface CaseQuery {
  platform?: Address;
  shop?: Address;
  month?: string;
}

export interface DocketStore {
  readonly kind: StoreKind;
  createCase(row: CaseRow): Promise<WriteReceipt>;
  patchCase(entityKey: string, set: Partial<CaseRow>): Promise<{ txHash?: string }>;
  findCase(claimId: string): Promise<Stored<CaseRow> | null>;
  listCases(query?: CaseQuery): Promise<Stored<CaseRow>[]>;
  createCount(row: CountRow): Promise<WriteReceipt>;
  patchCount(entityKey: string, set: Partial<CountRow>): Promise<{ txHash?: string }>;
  findCount(key: { month: string; platform: Address; shop: Address }): Promise<Stored<CountRow> | null>;
  listCounts(query?: CaseQuery): Promise<Stored<CountRow>[]>;
  /** State of a write transaction; stores without transactions answer `success`. */
  txState(txHash: string): Promise<TxState>;
}

/** Only the attributes that differ. */
export function diffCase(prev: CaseRow, next: CaseRow): Partial<CaseRow> {
  const out: Record<string, unknown> = {};
  for (const def of CASE_ATTRS) {
    const k = def.name as keyof CaseRow;
    if (String(prev[k]) !== String(next[k])) out[k] = next[k];
  }
  return out as Partial<CaseRow>;
}

export function diffCount(prev: CountRow, next: CountRow): Partial<CountRow> {
  const out: Record<string, unknown> = {};
  for (const def of COUNT_ATTRS) {
    const k = def.name as keyof CountRow;
    if (String(prev[k]) !== String(next[k])) out[k] = next[k];
  }
  return out as Partial<CountRow>;
}

/** Why a write failed, in the words the write status reports. */
export type WriteErrorKind = 'auth' | 'quota' | 'gas' | 'rpc';

export class StoreError extends Error {
  constructor(
    readonly kind: WriteErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Sorts a thrown value into a StoreError kind. Never includes the raw message of an auth failure. */
export function classifyError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const lower = text.toLowerCase();
  if (/\b401\b|unauthori[sz]ed|invalid access key|api key/.test(lower)) return new StoreError('auth', 'access key rejected (401)');
  if (/\b429\b|quota|rate.?limit|too many requests/.test(lower)) return new StoreError('quota', 'quota or rate limit reached');
  if (/gas|insufficient funds|out of gas|intrinsic/.test(lower)) return new StoreError('gas', 'not enough gas or funds');
  return new StoreError('rpc', text.slice(0, 200));
}
