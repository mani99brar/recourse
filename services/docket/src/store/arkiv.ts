// Arkiv store: maps rows to entities through a small `ArkivIo` port. The SDK-backed port is in
// `arkivSdk.ts`; tests use an in-memory one. Reads page 100 rows at a time until a short page.

import { getAddress, type Address } from 'viem';
import {
  CASE_ATTRS,
  CASE_SCHEMA_NAME,
  COUNT_ATTRS,
  COUNT_SCHEMA_NAME,
  type AttrDef,
  type CaseRow,
  type CountRow,
} from '../schema.js';
import { classifyError, type CaseQuery, type DocketStore, type Stored, type TxState, type WriteReceipt } from './types.js';

export type PlainValue = string | number | bigint | boolean;
export type SchemaName = typeof CASE_SCHEMA_NAME | typeof COUNT_SCHEMA_NAME;

export interface ArkivEntity {
  entityKey: string;
  /** Attribute values as plain JS: u64 as bigint, addr as address, str as string, bool as boolean. */
  values: Record<string, PlainValue>;
}

/** The three things the docket needs from Arkiv. Every `query` is scoped to the writer's entities. */
export interface ArkivIo {
  create(schema: SchemaName, values: Record<string, PlainValue>): Promise<{ entityKey: string; txHash: string }>;
  patch(schema: SchemaName, entityKey: string, set: Record<string, PlainValue>): Promise<{ txHash: string }>;
  /** Entities of the schema owned by the writer where every pair is equal. */
  query(schema: SchemaName, equals: readonly (readonly [string, PlainValue])[], offset: number, limit: number): Promise<ArkivEntity[]>;
  txState(txHash: string): Promise<TxState>;
}

function toWire(defs: readonly AttrDef[], row: object): Record<string, PlainValue> {
  const out: Record<string, PlainValue> = {};
  for (const def of defs) {
    const v = (row as Record<string, unknown>)[def.name];
    if (v === undefined) continue;
    out[def.name] = def.type === 'u64' ? BigInt(v as string | number) : def.type === 'addr' ? getAddress(v as string) : (v as PlainValue);
  }
  return out;
}

function fromWire(defs: readonly AttrDef[], values: Record<string, PlainValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const v = values[def.name] ?? def.sentinel;
    if (def.type === 'u64') out[def.name] = def.name === 'toShopUsdc' ? BigInt(v as bigint | number).toString() : Number(v);
    else out[def.name] = v;
  }
  return out;
}

export class ArkivStore implements DocketStore {
  readonly kind = 'arkiv' as const;

  constructor(
    private readonly io: ArkivIo,
    private readonly pageSize = 100,
  ) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError('page size must be 1-100');
  }

  async createCase(row: CaseRow): Promise<WriteReceipt> {
    return this.guard(() => this.io.create(CASE_SCHEMA_NAME, toWire(CASE_ATTRS, row)));
  }

  async patchCase(entityKey: string, set: Partial<CaseRow>): Promise<{ txHash?: string }> {
    return this.guard(() => this.io.patch(CASE_SCHEMA_NAME, entityKey, toWire(CASE_ATTRS, set)));
  }

  async findCase(claimId: string): Promise<Stored<CaseRow> | null> {
    const rows = await this.readAll(CASE_SCHEMA_NAME, [['claimId', claimId.toLowerCase()]], 1);
    const e = rows[0];
    return e === undefined ? null : { entityKey: e.entityKey, row: fromWire(CASE_ATTRS, e.values) as unknown as CaseRow };
  }

  async listCases(query: CaseQuery = {}): Promise<Stored<CaseRow>[]> {
    const rows = await this.readAll(CASE_SCHEMA_NAME, equalsOf(query, [['tier', 'ruled']]));
    return rows.map((e) => ({ entityKey: e.entityKey, row: fromWire(CASE_ATTRS, e.values) as unknown as CaseRow }));
  }

  async createCount(row: CountRow): Promise<WriteReceipt> {
    return this.guard(() => this.io.create(COUNT_SCHEMA_NAME, toWire(COUNT_ATTRS, row)));
  }

  async patchCount(entityKey: string, set: Partial<CountRow>): Promise<{ txHash?: string }> {
    return this.guard(() => this.io.patch(COUNT_SCHEMA_NAME, entityKey, toWire(COUNT_ATTRS, set)));
  }

  async findCount(key: { month: string; platform: Address; shop: Address }): Promise<Stored<CountRow> | null> {
    const rows = await this.readAll(COUNT_SCHEMA_NAME, equalsOf(key), 1);
    const e = rows[0];
    return e === undefined ? null : { entityKey: e.entityKey, row: fromWire(COUNT_ATTRS, e.values) as unknown as CountRow };
  }

  async listCounts(query: CaseQuery = {}): Promise<Stored<CountRow>[]> {
    const rows = await this.readAll(COUNT_SCHEMA_NAME, equalsOf(query, [['tier', 'reported']]));
    return rows.map((e) => ({ entityKey: e.entityKey, row: fromWire(COUNT_ATTRS, e.values) as unknown as CountRow }));
  }

  txState(txHash: string): Promise<TxState> {
    return this.io.txState(txHash);
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw classifyError(error);
    }
  }

  /** Pages with limit and offset until a short page; `max` stops early. */
  private async readAll(schema: SchemaName, equals: readonly (readonly [string, PlainValue])[], max = Infinity): Promise<ArkivEntity[]> {
    const out: ArkivEntity[] = [];
    for (let offset = 0; out.length < max; offset += this.pageSize) {
      const page = await this.guard(() => this.io.query(schema, equals, offset, this.pageSize));
      out.push(...page);
      if (page.length < this.pageSize) break;
    }
    return out.slice(0, max);
  }
}

function equalsOf(
  q: { platform?: Address; shop?: Address; month?: string },
  extra: readonly (readonly [string, PlainValue])[] = [],
): (readonly [string, PlainValue])[] {
  const eqs: (readonly [string, PlainValue])[] = [...extra];
  if (q.platform !== undefined) eqs.push(['platform', getAddress(q.platform)]);
  if (q.shop !== undefined) eqs.push(['shop', getAddress(q.shop)]);
  if (q.month !== undefined) eqs.push(['month', q.month]);
  return eqs;
}
