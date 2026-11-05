// TEST ONLY: an in-memory stand-in for Arkiv. It keeps entities in a map, enforces the same
// attribute rules the node does, and can be told to fail the next writes. Nothing here is real data.

import type { ArkivEntity, ArkivIo, PlainValue, SchemaName } from '../src/store/arkiv.js';
import { StoreError, type TxState } from '../src/store/types.js';

export class MemoryArkivIo implements ArkivIo {
  readonly entities = new Map<string, { schema: SchemaName; values: Record<string, PlainValue> }>();
  readonly sent: { op: 'create' | 'patch'; schema: SchemaName; txHash: string }[] = [];
  readonly queries: { schema: SchemaName; equals: readonly (readonly [string, PlainValue])[]; offset: number; limit: number }[] = [];
  /** Throw this on the next write(s). */
  failWith: Error[] = [];
  txStates = new Map<string, TxState>();
  /** When true a create lands on chain (entity exists) but the call throws, like a lost response. */
  loseResponse = false;
  private n = 0;

  private nextFailure(): void {
    const e = this.failWith.shift();
    if (e) throw e;
  }

  async create(schema: SchemaName, values: Record<string, PlainValue>): Promise<{ entityKey: string; txHash: string }> {
    this.nextFailure();
    this.n += 1;
    const entityKey = `0x${this.n.toString(16).padStart(64, '0')}`;
    const txHash = `0x${(0x1000 + this.n).toString(16).padStart(64, '0')}`;
    this.entities.set(entityKey, { schema, values: { ...values } });
    this.sent.push({ op: 'create', schema, txHash });
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new StoreError('rpc', 'response lost');
    }
    return { entityKey, txHash };
  }

  async patch(schema: SchemaName, entityKey: string, set: Record<string, PlainValue>): Promise<{ txHash: string }> {
    this.nextFailure();
    const e = this.entities.get(entityKey);
    if (e === undefined) throw new Error('no such entity');
    Object.assign(e.values, set);
    this.n += 1;
    const txHash = `0x${(0x1000 + this.n).toString(16).padStart(64, '0')}`;
    this.sent.push({ op: 'patch', schema, txHash });
    return { txHash };
  }

  async query(schema: SchemaName, equals: readonly (readonly [string, PlainValue])[], offset: number, limit: number): Promise<ArkivEntity[]> {
    this.queries.push({ schema, equals, offset, limit });
    if (limit > 100) throw new Error('limit over 100');
    const rows: ArkivEntity[] = [];
    for (const [entityKey, e] of this.entities) {
      if (e.schema !== schema) continue;
      if (!equals.every(([k, v]) => String(e.values[k]).toLowerCase() === String(v).toLowerCase())) continue;
      rows.push({ entityKey, values: { ...e.values } });
    }
    return rows.slice(offset, offset + limit);
  }

  async txState(txHash: string): Promise<TxState> {
    return this.txStates.get(txHash) ?? 'success';
  }
}
