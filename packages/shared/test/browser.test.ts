import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The barrel must run in a browser: walk every module it reaches and check none of them imports
// a Node built-in, uses Node globals, or pulls in the Node-only entry.
const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const NODE_BUILTINS = /^(node:|fs$|path$|os$|crypto$|child_process$|url$|stream$|buffer$|util$)/;

function walk(file: string, seen: Set<string>): void {
  if (seen.has(file)) return;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1]!;
    expect(spec, `${file} imports ${spec}`).not.toMatch(NODE_BUILTINS);
    if (spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')), seen);
    else expect(['viem', 'viem/accounts'], `${file} imports ${spec}`).toContain(spec);
  }
}

describe('browser safety', () => {
  it('the barrel reaches only browser-safe modules', () => {
    const seen = new Set<string>();
    walk(resolve(src, 'index.ts'), seen);
    for (const file of seen) {
      expect(file.includes('/node/'), `${file} is Node-only`).toBe(false);
      const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\bBuffer\b|\bprocess\.env\b|\brequire\(/);
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});
