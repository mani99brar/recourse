// Arkiv entity schemas for the docket: `case` (one per ruled claim) and `monthly-count` (one per
// month, platform and shop). The tables below are the single description; the Arkiv adapter builds
// its SDK schemas from them and `arkiv/schema.md` documents them.

import type { Address } from 'viem';

export type AttrType = 'str' | 'u64' | 'addr' | 'bool';

export interface AttrDef {
  name: string;
  type: AttrType;
  /** Indexed attributes can be filtered on; the rest are stored and selectable only. */
  indexed: boolean;
  /** Longest possible value in bytes, for `str` attributes. */
  maxBytes?: number;
  /** Value written when nothing is known. */
  sentinel: string | number | boolean;
}

export const SCHEMA_VERSION = 1;
export const CASE_SCHEMA_NAME = 'case';
export const COUNT_SCHEMA_NAME = 'monthly-count';

/** Arkiv allows 32 attributes per entity; a named schema spends one on its `arkiv.schema` tag. */
export const MAX_SCHEMA_ATTRIBUTES = 31;
export const MAX_ATTRIBUTE_NAME_BYTES = 32;
export const MAX_STR_BYTES = 128;
/** An entity may live 7,884,000 blocks (about 182.5 days) from the block it lands in. */
export const MAX_LIFETIME_BLOCKS = 7_884_000;
export const BLOCK_SECONDS = 2;

const str = (name: string, indexed: boolean, maxBytes: number, sentinel = ''): AttrDef => ({ name, type: 'str', indexed, maxBytes, sentinel });
const u64 = (name: string, indexed: boolean): AttrDef => ({ name, type: 'u64', indexed, sentinel: 0 });
const addr = (name: string): AttrDef => ({ name, type: 'addr', indexed: true, sentinel: '0x0000000000000000000000000000000000000000' });
const bool = (name: string, indexed: boolean): AttrDef => ({ name, type: 'bool', indexed, sentinel: false });

/** Indexed: claimId, platform, shop, gap, answer, ruling, outcome, unresolved, tier, month, settledAt. */
export const CASE_ATTRS: readonly AttrDef[] = [
  str('claimId', true, 66),
  addr('platform'),
  addr('shop'),
  u64('gap', true),
  u64('answer', true),
  u64('ruling', true),
  u64('outcome', true),
  bool('unresolved', true),
  bool('zeroTwice', false),
  str('tier', true, 16),
  str('month', true, 7),
  u64('attempts', false),
  str('disputeId', false, 78),
  u64('inclusionBps', false),
  u64('toShopUsdc', false),
  u64('settledAt', true),
  str('reasonCid', false, 128),
  u64('v', false),
];

export const COUNT_FIELDS = [
  'filed',
  'gap1',
  'gap2',
  'gap3',
  'noGap',
  'notEnough',
  'missingRecord',
  'notPreChecked',
  'ruled',
  'unresolved',
  'closedUncontested',
  'open',
  'ruledNotWritten',
  'expired',
  'undrawn',
] as const;
export type CountField = (typeof COUNT_FIELDS)[number];

export const COUNT_ATTRS: readonly AttrDef[] = [
  str('month', true, 7),
  addr('platform'),
  addr('shop'),
  str('tier', true, 16),
  ...COUNT_FIELDS.map((f) => u64(f, false)),
  u64('v', false),
];

/** Status buckets: every claim sits in exactly one, and `filed` is their sum. */
export const STATUS_PARTITION = ['ruled', 'unresolved', 'closedUncontested', 'open', 'ruledNotWritten', 'expired', 'undrawn'] as const satisfies readonly CountField[];
/** Gap buckets: every claim sits in exactly one, and `filed` is their sum. */
export const GAP_PARTITION = ['gap1', 'gap2', 'gap3', 'noGap', 'notEnough', 'missingRecord', 'notPreChecked'] as const satisfies readonly CountField[];

export const CASE_TIER = 'ruled';
export const COUNT_TIER = 'reported';

/** A `case` entity as the docket holds it. u64 amounts that can be large are decimal strings. */
export interface CaseRow {
  claimId: string; // lower-case 0x hex
  platform: Address;
  shop: Address;
  gap: number;
  answer: number;
  ruling: number;
  outcome: number;
  unresolved: boolean;
  zeroTwice: boolean;
  tier: string;
  month: string; // YYYY-MM, UTC, from filedAt
  attempts: number;
  disputeId: string; // decimal
  inclusionBps: number;
  toShopUsdc: string; // decimal, 6 decimals
  settledAt: number; // unix seconds, 0 = not settled
  reasonCid: string;
  v: number;
}

export interface CountRow {
  month: string;
  platform: Address;
  shop: Address;
  tier: string;
  filed: number;
  gap1: number;
  gap2: number;
  gap3: number;
  noGap: number;
  notEnough: number;
  missingRecord: number;
  notPreChecked: number;
  ruled: number;
  unresolved: number;
  closedUncontested: number;
  open: number;
  ruledNotWritten: number;
  expired: number;
  undrawn: number;
  v: number;
}

export function countKey(row: Pick<CountRow, 'month' | 'platform' | 'shop'>): string {
  return `${row.month}|${row.platform.toLowerCase()}|${row.shop.toLowerCase()}`;
}

/** `YYYY-MM` in UTC for a unix-seconds timestamp. */
export function monthOf(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear().toString().padStart(4, '0')}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}`;
}

/** Blocks for a lifetime in days, refusing anything above the chain's cap. */
export function lifetimeBlocks(days: number): number {
  const blocks = Math.floor((days * 86400) / BLOCK_SECONDS);
  if (!Number.isFinite(blocks) || blocks <= 0) throw new RangeError('lifetime must be positive');
  if (blocks > MAX_LIFETIME_BLOCKS) throw new RangeError(`lifetime of ${days} days is over the ${MAX_LIFETIME_BLOCKS}-block cap`);
  return blocks;
}

export function caseRowEquals(a: CaseRow, b: CaseRow): boolean {
  for (const def of CASE_ATTRS) {
    const key = def.name as keyof CaseRow;
    if (String(a[key]).toLowerCase() !== String(b[key]).toLowerCase()) return false;
  }
  return true;
}

export function countRowEquals(a: CountRow, b: CountRow): boolean {
  for (const def of COUNT_ATTRS) {
    const key = def.name as keyof CountRow;
    if (String(a[key]).toLowerCase() !== String(b[key]).toLowerCase()) return false;
  }
  return true;
}
