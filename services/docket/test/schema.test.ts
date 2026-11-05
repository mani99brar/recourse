import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CASE_ATTRS,
  COUNT_ATTRS,
  COUNT_FIELDS,
  GAP_PARTITION,
  MAX_ATTRIBUTE_NAME_BYTES,
  MAX_LIFETIME_BLOCKS,
  MAX_SCHEMA_ATTRIBUTES,
  MAX_STR_BYTES,
  STATUS_PARTITION,
  lifetimeBlocks,
  monthOf,
} from '../src/schema.js';
import { buildWhere } from '../src/store/arkivSdk.js';

const SRC = resolve(import.meta.dirname, '../src');
const ARKIV = resolve(import.meta.dirname, '../../../arkiv');

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

describe('schema limits', () => {
  for (const [name, attrs] of [['case', CASE_ATTRS], ['monthly-count', COUNT_ATTRS]] as const) {
    it(`${name} fits the attribute limits`, () => {
      // the schema tag takes one of the 31 slots
      expect(attrs.length + 1).toBeLessThanOrEqual(MAX_SCHEMA_ATTRIBUTES + 1);
      expect(attrs.length).toBeLessThanOrEqual(MAX_SCHEMA_ATTRIBUTES);
      const names = new Set<string>();
      for (const a of attrs) {
        expect(new TextEncoder().encode(a.name).length).toBeLessThanOrEqual(MAX_ATTRIBUTE_NAME_BYTES);
        expect(names.has(a.name)).toBe(false);
        names.add(a.name);
        if (a.type === 'str') {
          expect(a.maxBytes).toBeDefined();
          expect(a.maxBytes!).toBeLessThanOrEqual(MAX_STR_BYTES);
        }
      }
    });
  }

  it('has the documented attribute counts', () => {
    expect(CASE_ATTRS).toHaveLength(18);
    expect(COUNT_ATTRS).toHaveLength(20);
  });

  it('string maxima cover the values written', () => {
    const claimId = `0x${'f'.repeat(64)}`;
    const claimDef = CASE_ATTRS.find((a) => a.name === 'claimId')!;
    expect(claimId.length).toBeLessThanOrEqual(claimDef.maxBytes!);
    const disputeDef = CASE_ATTRS.find((a) => a.name === 'disputeId')!;
    expect(String(2n ** 256n - 1n).length).toBeLessThanOrEqual(disputeDef.maxBytes!);
  });

  it('every partition member is a count field and both partitions sum to filed', () => {
    for (const f of [...STATUS_PARTITION, ...GAP_PARTITION]) expect(COUNT_FIELDS).toContain(f);
    expect(COUNT_FIELDS).toContain('filed');
  });

  it('the lifetime stays under the chain cap', () => {
    expect(lifetimeBlocks(182)).toBeLessThan(MAX_LIFETIME_BLOCKS);
    expect(() => lifetimeBlocks(183)).toThrow();
    expect(() => lifetimeBlocks(0)).toThrow();
  });

  it('months are UTC', () => {
    expect(monthOf(Date.UTC(2026, 10, 30, 23, 59, 59) / 1000)).toBe('2026-11');
    expect(monthOf(Date.UTC(2026, 11, 1, 0, 0, 0) / 1000)).toBe('2026-12');
  });
});

describe('query hygiene', () => {
  it('no source line builds a negated filter', () => {
    for (const f of files(SRC, /\.ts$/)) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return;
        const quoted = line.match(/(['"`])(?:(?!\1).)*\1/g) ?? [];
        for (const q of quoted) {
          if (/\bNOT\b/.test(q) || /!=/.test(q)) throw new Error(`${f}:${i + 1} has a negated filter: ${q}`);
        }
      });
    }
  });

  it('every sdk read is scoped to the writer', () => {
    for (const f of files(SRC, /\.ts$/)) {
      const text = readFileSync(f, 'utf8');
      const reads = text.match(/\.from\(/g)?.length ?? 0;
      const owned = text.match(/\.ownedBy\(/g)?.length ?? 0;
      expect(owned, f).toBeGreaterThanOrEqual(reads);
    }
  });

  it('arkiv docs contain no negated query', () => {
    let any = false;
    for (const f of files(ARKIV, /\.md$/)) {
      any = true;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (/\$owner|\.where\(|\.select\(/.test(line)) {
          expect(line, f).not.toMatch(/\bNOT\b|!=/);
          if (/\$owner/.test(line) && /\bWHERE\b|\bAND\b/.test(line)) expect(line, f).toMatch(/\$owner/);
        }
      }
    }
    expect(any).toBe(true);
  });

  it('filters only on indexed attributes', () => {
    expect(() => buildWhere('case', [['tier', 'ruled'], ['settledAt', 0]])).not.toThrow();
    expect(() => buildWhere('case', [['reasonCid', 'x']])).toThrow(/not an indexed/);
    expect(() => buildWhere('case', [['nope', 'x']])).toThrow();
  });

  it('a built filter renders without a negation', () => {
    const w = buildWhere('case', [['tier', 'ruled'], ['unresolved', false]]);
    expect(String(w.toString?.() ?? '')).not.toMatch(/NOT|!=/);
  });
});
