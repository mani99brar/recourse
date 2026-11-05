import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');

function importsOf(file: string): string[] {
  const text = readFileSync(resolve(SRC, file), 'utf8');
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

// Walks the import graph of the package entry and returns every specifier it reaches.
function reach(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(entry)) return seen;
  const specs = importsOf(entry);
  seen.set(entry, specs);
  for (const s of specs) if (s.startsWith('.')) reach(s.replace(/^\.\//, '').replace(/\.js$/, '.ts'), seen);
  return seen;
}

describe('browser entry', () => {
  it('reaches only the rates module', () => {
    const graph = reach('index.ts');
    expect([...graph.keys()].sort()).toEqual(['index.ts', 'rates.ts']);
  });

  it('imports no package, Node built-in or service module', () => {
    for (const [file, specs] of reach('index.ts')) {
      for (const s of specs) {
        expect(s.startsWith('.'), `${file} imports ${s}`).toBe(true);
        expect(s).not.toMatch(/node:|express|shared\/node|main/);
      }
    }
  });

  it('uses no Node globals', () => {
    const text = readFileSync(resolve(SRC, 'rates.ts'), 'utf8');
    expect(text).not.toMatch(/\bprocess\.|\bBuffer\b|require\(/);
  });
});
