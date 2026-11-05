// The fault rule: given the order's records, name the first gap and the side at fault.
// Pure and deterministic (no clock, no randomness, no I/O), so the pre-check service, the intake
// service and the browser all get the same answer from the same records.

import type { Hex } from 'viem';
import { sideOf, type Answer, type Gap, type Side } from './codes.js';
import { parseCanonical } from './hashing.js';
import {
  ATTRIBUTES,
  RECORD_KEYS,
  isAttribute,
  type ApprovalBasis,
  type ApprovalValue,
  type Attribute,
  type RecordKey,
  type RecordKind,
} from './records.js';

export const RULE_VERSION = '1';

export type Attrs = Partial<Record<Attribute, string>>;

/** asked, ordered, packed, arrived. */
export interface AttrSlot {
  attrs: Attrs;
}
/** shown: attributes plus the change slot (attributes the screen said had changed; [] when none). */
export interface ShownSlot {
  attrs: Attrs;
  changes: Attribute[];
}
/** approval: the buyer's answer, or the agent's mandate for buys below the spend limit. */
export interface ApprovalSlot {
  approval: ApprovalValue;
  approvalBasis?: ApprovalBasis;
}

/**
 * One entry per record; leave a record out when it is missing or failed verification (zero hash,
 * hash mismatch, non-canonical bytes, wrong HCS payer). The rule never fetches.
 */
export interface RuleInput {
  asked?: AttrSlot;
  shown?: ShownSlot;
  approval?: ApprovalSlot;
  ordered?: AttrSlot;
  packed?: AttrSlot;
  arrived?: AttrSlot;
}

export type AttrRecordKey = Exclude<RecordKey, 'approval'>;

export const RULE_STEPS = ['1', '2a-i', '2a-ii', '2a-iii', '2b', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] as const;
export type RuleStep = (typeof RULE_STEPS)[number];

export const REASON_KEYS = [
  'not_enough_record',
  'missing_record_platform',
  'missing_record_shop',
  'gap1_asked_vs_shown',
  'gap2_shown_vs_ordered',
  'gap3_ordered_vs_packed',
  'gap3_packed_vs_arrived',
  'gap3_no_pack_record',
  'no_gap_approved_change',
  'no_gap_all_agree',
  'no_gap_in_compared',
] as const;
export type ReasonKey = (typeof REASON_KEYS)[number];

export interface FlaggedCell {
  record: AttrRecordKey;
  attribute: Attribute;
}

export interface PrecheckResult {
  gap: Gap;
  answer: Answer;
  side: Side;
  reasonKey: ReasonKey;
  /** Decision-table row that matched. */
  step: RuleStep;
  /** (record, attribute) cells behind the finding, in attribute then record order. */
  flaggedCells: FlaggedCell[];
  /** Held attributes the rule had no pair to compare, in attribute order. */
  notCompared: Attribute[];
  /** Records holding a price that does not parse (compared as text), in record order. */
  unreadPrice: AttrRecordKey[];
}

const ATTR_RECORDS: readonly AttrRecordKey[] = ['asked', 'shown', 'ordered', 'packed', 'arrived'];

/** Trimmed, lower-cased. */
export function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Parses a price text to a normalised decimal string, or null. Commas are dropped; the text may
 * hold no minus sign and exactly one number (digits with at most one decimal point); other words
 * are ignored. "1,200 usdc" -> "1200", "095.50" -> "95.5".
 */
export function parsePrice(text: string): string | null {
  const t = text.replace(/,/g, '');
  if (t.includes('-')) return null;
  const runs = (t.match(/[0-9.]+/g) ?? []).filter((r) => /\d/.test(r));
  if (runs.length !== 1) return null;
  const run = runs[0]!;
  if (!/^\d+(\.\d+)?$/.test(run)) return null;
  const [intPart, fracPart = ''] = run.split('.') as [string, string?];
  const i = intPart.replace(/^0+/, '') || '0';
  const f = fracPart.replace(/0+$/, '');
  return f === '' ? i : `${i}.${f}`;
}

/** Exact comparison of two normalised decimal strings: -1, 0 or 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [ai, af = ''] = a.split('.') as [string, string?];
  const [bi, bf = ''] = b.split('.') as [string, string?];
  const len = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(len, '0'));
  const y = BigInt(bi + bf.padEnd(len, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Steps 2a and 2b: does X depart from what was asked? Asked's price is a cap. */
function departs(attribute: Attribute, asked: string, x: string): boolean {
  if (attribute === 'price') {
    const pa = parsePrice(asked);
    const px = parsePrice(x);
    if (pa !== null && px !== null) return compareDecimal(px, pa) > 0;
  }
  return asked !== x;
}

/** Steps 3-6: do two records differ on an attribute? */
function differs(attribute: Attribute, x: string, y: string): boolean {
  if (attribute === 'price') {
    const px = parsePrice(x);
    const py = parsePrice(y);
    if (px !== null && py !== null) return compareDecimal(px, py) !== 0;
  }
  return x !== y;
}

interface View {
  cell(record: AttrRecordKey, attribute: Attribute): string | undefined;
  held(record: AttrRecordKey): boolean;
  changeFilled: boolean;
  approved: boolean;
}

function view(input: RuleInput): View {
  const cells = new Map<string, string>();
  for (const record of ATTR_RECORDS) {
    const attrs = input[record]?.attrs;
    if (typeof attrs !== 'object' || attrs === null) continue;
    for (const a of ATTRIBUTES) {
      const raw = attrs[a];
      if (typeof raw !== 'string') continue;
      const n = normalise(raw);
      if (n !== '') cells.set(`${record}.${a}`, n);
    }
  }
  const changes = input.shown?.changes;
  const changeFilled = Array.isArray(changes) && changes.length > 0;
  const holdsAttr = (r: AttrRecordKey) => ATTRIBUTES.some((a) => cells.has(`${r}.${a}`));
  const held = (r: AttrRecordKey) => holdsAttr(r) || (r === 'shown' && changeFilled);
  return {
    cell: (r, a) => cells.get(`${r}.${a}`),
    held,
    changeFilled,
    approved: held('shown') && input.approval?.approval === 'approved',
  };
}

function cellsFor(attributes: readonly Attribute[], records: readonly AttrRecordKey[]): FlaggedCell[] {
  const set = new Set(attributes);
  const out: FlaggedCell[] = [];
  for (const attribute of ATTRIBUTES) {
    if (!set.has(attribute)) continue;
    for (const record of ATTR_RECORDS) if (records.includes(record)) out.push({ record, attribute });
  }
  return out;
}

const OUTCOME: Record<ReasonKey, { gap: Gap; answer: Answer }> = {
  not_enough_record: { gap: 255, answer: 0 },
  missing_record_platform: { gap: 255, answer: 1 },
  missing_record_shop: { gap: 255, answer: 2 },
  gap1_asked_vs_shown: { gap: 1, answer: 1 },
  gap2_shown_vs_ordered: { gap: 2, answer: 1 },
  gap3_ordered_vs_packed: { gap: 3, answer: 2 },
  gap3_packed_vs_arrived: { gap: 3, answer: 2 },
  gap3_no_pack_record: { gap: 3, answer: 2 },
  no_gap_approved_change: { gap: 0, answer: 3 },
  no_gap_all_agree: { gap: 0, answer: 3 },
  no_gap_in_compared: { gap: 0, answer: 3 },
};

interface Decision {
  step: RuleStep;
  reasonKey: ReasonKey;
  flaggedCells: FlaggedCell[];
}

function decide(v: View): Decision {
  const none: FlaggedCell[] = [];
  const pairDiff = (x: AttrRecordKey, y: AttrRecordKey) =>
    ATTRIBUTES.filter((a) => {
      const cx = v.cell(x, a);
      const cy = v.cell(y, a);
      return cx !== undefined && cy !== undefined && differs(a, cx, cy);
    });

  // 1
  if (!v.held('ordered')) return { step: '1', reasonKey: 'not_enough_record', flaggedCells: none };

  let cleared = false;
  if (v.held('asked')) {
    // 2a: the order departs from the request and the screen did not show a value that keeps to it.
    const off = ATTRIBUTES.filter((a) => {
      const i = v.cell('asked', a);
      const o = v.cell('ordered', a);
      if (i === undefined || o === undefined || !departs(a, i, o)) return false;
      const s = v.cell('shown', a);
      return s === undefined || departs(a, i, s);
    });
    if (off.length > 0) {
      if (!v.held('shown')) {
        return { step: '2a-i', reasonKey: 'missing_record_platform', flaggedCells: cellsFor(off, ['asked', 'ordered']) };
      }
      const notShown = off.filter((a) => {
        const s = v.cell('shown', a);
        return !v.changeFilled || s === undefined || differs(a, s, v.cell('ordered', a)!);
      });
      if (notShown.length > 0) {
        return {
          step: '2a-ii',
          reasonKey: 'gap1_asked_vs_shown',
          flaggedCells: cellsFor(notShown, ['asked', 'shown', 'ordered']),
        };
      }
      if (!v.approved) {
        return { step: '2a-iii', reasonKey: 'gap1_asked_vs_shown', flaggedCells: cellsFor(off, ['asked', 'ordered']) };
      }
      cleared = true; // 2a-iv
    }
    // 2b: the screen departed from the request while the order kept to it.
    if (!(v.changeFilled && v.approved)) {
      const shownOff = ATTRIBUTES.filter((a) => {
        const i = v.cell('asked', a);
        const s = v.cell('shown', a);
        const o = v.cell('ordered', a);
        return i !== undefined && s !== undefined && o !== undefined && departs(a, i, s) && !departs(a, i, o);
      });
      if (shownOff.length > 0) {
        return { step: '2b', reasonKey: 'gap1_asked_vs_shown', flaggedCells: cellsFor(shownOff, ['asked', 'shown']) };
      }
    }
  }

  // 3-6
  if (v.held('shown')) {
    const d = pairDiff('shown', 'ordered');
    if (d.length > 0) return { step: '3', reasonKey: 'gap2_shown_vs_ordered', flaggedCells: cellsFor(d, ['shown', 'ordered']) };
  }
  if (v.held('packed')) {
    const d = pairDiff('ordered', 'packed');
    if (d.length > 0) return { step: '4', reasonKey: 'gap3_ordered_vs_packed', flaggedCells: cellsFor(d, ['ordered', 'packed']) };
    if (v.held('arrived')) {
      const d2 = pairDiff('packed', 'arrived');
      if (d2.length > 0) {
        return { step: '5', reasonKey: 'gap3_packed_vs_arrived', flaggedCells: cellsFor(d2, ['packed', 'arrived']) };
      }
    }
  } else if (v.held('arrived')) {
    const d = pairDiff('ordered', 'arrived');
    if (d.length > 0) return { step: '6', reasonKey: 'gap3_no_pack_record', flaggedCells: cellsFor(d, ['ordered', 'arrived']) };
  }

  // 7-10: absences, after every break.
  const platformMissing = !v.held('asked') || !v.held('shown');
  if ((platformMissing || !v.approved) && !v.held('packed')) {
    return { step: '7', reasonKey: 'not_enough_record', flaggedCells: none };
  }
  if (platformMissing) return { step: '8', reasonKey: 'missing_record_platform', flaggedCells: none };
  if (!v.approved) return { step: '9', reasonKey: 'missing_record_platform', flaggedCells: none };
  if (!v.held('packed')) return { step: '10', reasonKey: 'missing_record_shop', flaggedCells: none };

  // 11-12
  if (cleared) return { step: '11', reasonKey: 'no_gap_approved_change', flaggedCells: none };
  return { step: '12', reasonKey: 'no_gap_all_agree', flaggedCells: none };
}

function notComparedOf(v: View): Attribute[] {
  const packedHeld = v.held('packed');
  return ATTRIBUTES.filter((a) => {
    const holders = ATTR_RECORDS.filter((r) => v.cell(r, a) !== undefined);
    if (holders.length === 0) return false;
    const has = (r: AttrRecordKey) => holders.includes(r);
    const compared = has('ordered') && (has('asked') || has('shown') || has('packed') || (!packedHeld && has('arrived')));
    return !compared;
  });
}

/** Runs the rule. Same input, same output. */
export function runFaultRule(input: RuleInput): PrecheckResult {
  const v = view(input);
  const d = decide(v);
  const notCompared = notComparedOf(v);
  let reasonKey = d.reasonKey;
  if ((d.step === '11' || d.step === '12') && (notCompared.length > 0 || (d.step === '12' && !v.held('arrived')))) {
    reasonKey = 'no_gap_in_compared';
  }
  const unreadPrice = ATTR_RECORDS.filter((r) => {
    const p = v.cell(r, 'price');
    return p !== undefined && parsePrice(p) === null;
  });
  const { gap, answer } = OUTCOME[reasonKey];
  return { gap, answer, side: sideOf(answer), reasonKey, step: d.step, flaggedCells: d.flaggedCells, notCompared, unreadPrice };
}

/** A verified record, placed in its RuleInput slot. */
export type RuleSlot =
  | { key: 'asked' | 'ordered' | 'packed' | 'arrived'; slot: AttrSlot }
  | { key: 'shown'; slot: ShownSlot }
  | { key: 'approval'; slot: ApprovalSlot };

export type RuleSlotResult = ({ ok: true } & RuleSlot) | { ok: false; error: string };

/** Returns a copy of the input with the slot set. */
export function withSlot(input: RuleInput, s: RuleSlot): RuleInput {
  return { ...input, [s.key]: s.slot };
}

function readAttrs(value: unknown): Attrs | undefined {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Attrs = {};
  for (const [k, v] of Object.entries(value)) {
    if (!isAttribute(k)) continue; // other attributes are not the rule's
    if (typeof v !== 'string') return undefined;
    out[k] = v;
  }
  return out;
}

/**
 * Maps the bytes of a record document to its rule slot, reading only the core fields: v "1",
 * kind (the record key), orderId, attrs, changes (shown), approval and approvalBasis (approval),
 * x402TxId (ordered). Invalid for non-canonical bytes, a wrong kind, an orderId other than the
 * expected one, or a core field of the wrong shape. Never fetches.
 */
export function ruleSlotFromDoc(kind: RecordKind, bytes: Uint8Array, orderId: Hex): RuleSlotResult {
  const parsed = parseCanonical(bytes);
  if (!parsed.ok) return { ok: false, error: 'not canonical' };
  const doc = parsed.value;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { ok: false, error: 'not an object' };
  const d = doc as Record<string, unknown>;
  const key = RECORD_KEYS[kind];
  if (key === undefined) return { ok: false, error: 'unknown kind' };
  if (d.v !== '1') return { ok: false, error: 'v must be "1"' };
  if (d.kind !== key) return { ok: false, error: 'wrong kind' };
  if (typeof d.orderId !== 'string' || d.orderId !== orderId.toLowerCase()) return { ok: false, error: 'wrong orderId' };

  if (key === 'approval') {
    if (d.approval !== 'approved' && d.approval !== 'not_approved') return { ok: false, error: 'bad approval' };
    if (d.approvalBasis !== undefined && d.approvalBasis !== 'buyer' && d.approvalBasis !== 'mandate') {
      return { ok: false, error: 'bad approvalBasis' };
    }
    const slot: ApprovalSlot = { approval: d.approval };
    if (d.approvalBasis !== undefined) slot.approvalBasis = d.approvalBasis;
    return { ok: true, key, slot };
  }

  const attrs = readAttrs(d.attrs);
  if (attrs === undefined) return { ok: false, error: 'bad attrs' };
  if (key === 'shown') {
    if (!Array.isArray(d.changes) || !d.changes.every(isAttribute)) return { ok: false, error: 'bad changes' };
    return { ok: true, key, slot: { attrs, changes: [...d.changes] } };
  }
  if (key === 'ordered' && d.x402TxId !== undefined && (typeof d.x402TxId !== 'string' || d.x402TxId === '')) {
    return { ok: false, error: 'bad x402TxId' };
  }
  return { ok: true, key, slot: { attrs } };
}
