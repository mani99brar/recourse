// The Arkiv SDK behind the `ArkivIo` port. Every read goes through `ownedBy(writer)`, because any
// project can write entities with the same schema name. No filter here is a negation: absence is
// tested with an equality on a sentinel value instead.

import {
  ExpirationTime,
  createPublicClient,
  createWalletClient,
  type PublicArkivClient,
  type WalletArkivClient,
} from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq } from '@arkiv-network/sdk/query';
import { addr, bool, defineSchema, str, u64 } from '@arkiv-network/sdk/schema';
import { getAddress, http, type Address, type Chain } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { CASE_ATTRS, CASE_SCHEMA_NAME, COUNT_ATTRS, COUNT_SCHEMA_NAME, lifetimeBlocks, type AttrDef } from '../schema.js';
import type { ArkivEntity, ArkivIo, PlainValue, SchemaName } from './arkiv.js';
import type { TxState } from './types.js';

type AnyColumns = Record<string, unknown>;

function columns(defs: readonly AttrDef[]): AnyColumns {
  const out: AnyColumns = {};
  for (const def of defs) {
    const base = def.type === 'str' ? str() : def.type === 'u64' ? u64() : def.type === 'addr' ? addr() : bool();
    out[def.name] = def.indexed ? (base as { indexed(): unknown }).indexed() : base;
  }
  return out;
}

const DEFS: Record<SchemaName, readonly AttrDef[]> = { [CASE_SCHEMA_NAME]: CASE_ATTRS, [COUNT_SCHEMA_NAME]: COUNT_ATTRS };

// The SDK types schemas by their literal columns; the docket builds them from tables, so the
// typed surface is deliberately loosened here, at the one place that needs it.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const arkivSchemas: Record<SchemaName, any> = {
  [CASE_SCHEMA_NAME]: (defineSchema as any)(CASE_SCHEMA_NAME, columns(CASE_ATTRS)),
  [COUNT_SCHEMA_NAME]: (defineSchema as any)(COUNT_SCHEMA_NAME, columns(COUNT_ATTRS)),
};

function typed(def: AttrDef | undefined, value: PlainValue): any {
  if (def === undefined) throw new Error('unknown attribute');
  if (def.type === 'u64') return u64(BigInt(value as bigint | number));
  if (def.type === 'addr') return addr(getAddress(value as string));
  if (def.type === 'bool') return bool(Boolean(value));
  return str(String(value));
}

function wireValues(schema: SchemaName, values: Record<string, PlainValue>): Record<string, any> {
  const defs = DEFS[schema];
  const out: Record<string, any> = {};
  for (const [name, v] of Object.entries(values)) out[name] = typed(defs.find((d) => d.name === name), v);
  return out;
}

/** The filter for a read: the writer's entities where every pair is equal. */
export function buildWhere(schema: SchemaName, equals: readonly (readonly [string, PlainValue])[]): any {
  const defs = DEFS[schema];
  const nodes = equals.map(([name, value]) => {
    const def = defs.find((d) => d.name === name);
    if (def === undefined || !def.indexed) throw new Error(`${schema}.${name} is not an indexed attribute`);
    return eq(name, typed(def, value));
  });
  return nodes.length === 1 ? nodes[0] : (and as any)(nodes);
}

export interface ArkivSdkConfig {
  /** Empty string uses the public endpoint (rate limited). */
  accessKey: string;
  /** Full RPC URL; when set it replaces the chain's default URL. */
  rpcUrl?: string;
  /** The writer: signs creates and patches, and owns every entity the docket reads. */
  account: PrivateKeyAccount;
  lifetimeDays: number;
}

export function arkivChain(accessKey: string, rpcUrl?: string): Chain {
  const chain = rabdi({ accessKey }) as Chain;
  if (rpcUrl === undefined || rpcUrl === '') return chain;
  return { ...chain, rpcUrls: { default: { http: [rpcUrl], webSocket: chain.rpcUrls.default.webSocket } } } as Chain;
}

export class SdkArkivIo implements ArkivIo {
  private readonly pub: PublicArkivClient;
  private readonly wallet: WalletArkivClient;
  private readonly expiration;

  constructor(private readonly config: ArkivSdkConfig) {
    // Refuse a lifetime over the chain's cap before any client is built.
    lifetimeBlocks(config.lifetimeDays);
    const chain = arkivChain(config.accessKey, config.rpcUrl);
    this.pub = createPublicClient({ chain, transport: http() }) as PublicArkivClient;
    this.wallet = createWalletClient({ chain, transport: http(), account: config.account }) as WalletArkivClient;
    this.expiration = ExpirationTime.fromDays(config.lifetimeDays);
  }

  get writer(): Address {
    return this.config.account.address;
  }

  async create(schema: SchemaName, values: Record<string, PlainValue>): Promise<{ entityKey: string; txHash: string }> {
    const r = await (this.wallet as any).createEntity(arkivSchemas[schema], wireValues(schema, values), { expiration: this.expiration });
    return { entityKey: r.entityKey, txHash: r.txHash };
  }

  async patch(schema: SchemaName, entityKey: string, set: Record<string, PlainValue>): Promise<{ txHash: string }> {
    const r = await (this.wallet as any).patchEntity(arkivSchemas[schema], entityKey, { set: wireValues(schema, set) });
    return { txHash: r.txHash };
  }

  async query(schema: SchemaName, equals: readonly (readonly [string, PlainValue])[], offset: number, limit: number): Promise<ArkivEntity[]> {
    const result = await (this.pub as any)
      .select()
      .from(arkivSchemas[schema])
      .where(buildWhere(schema, equals))
      .ownedBy(this.config.account.address)
      .limit(limit)
      .offset(offset)
      .fetch();
    return (result.entities as any[]).map((row) => {
      const values: Record<string, PlainValue> = {};
      for (const def of DEFS[schema]) {
        const cell = row[def.name];
        if (cell !== undefined) values[def.name] = cell.value as PlainValue;
      }
      return { entityKey: row.$key as string, values };
    });
  }

  async txState(txHash: string): Promise<TxState> {
    try {
      const receipt = await (this.pub as any).getTransactionReceipt({ hash: txHash });
      return receipt.status === 'success' ? 'success' : 'failed';
    } catch (error) {
      const text = error instanceof Error ? error.name : '';
      if (/NotFound/i.test(text)) return 'pending';
      return 'unknown';
    }
  }
}
