import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCursor, saveCursor } from '../src/cursor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('cursor', () => {
  it('saves and loads per source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-cursor-'));
    dirs.push(dir);
    expect(loadCursor(dir, 'hedera-claims')).toBeUndefined();
    saveCursor(dir, 'hedera-claims', { timestamp: '1.000000001' });
    saveCursor(dir, 'arbitrum-case', { block: '123' });
    saveCursor(dir, 'hedera-claims', { timestamp: '2.000000000' });
    expect(loadCursor(dir, 'hedera-claims')).toEqual({ timestamp: '2.000000000' });
    expect(loadCursor(dir, 'arbitrum-case')).toEqual({ block: '123' });
  });

  it('rejects source names that could escape the folder', () => {
    expect(() => saveCursor('/tmp', '../x', {})).toThrow(/bad source/);
  });
});
