import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stageDryRunState } from '../src/config.js';
import { loadCursor, saveCursor } from '../src/cursor.js';
import { openJournal } from '../src/journal.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

describe('dry-run state', () => {
  it('copies the journal, cursors and control file, and the dry run writes only the copy', () => {
    const live = temp('keeper-live-');
    const live0 = openJournal(live);
    live0.append({ t: 'event', claimId: '0x01' });
    live0.close();
    saveCursor(live, 'arbitrum', { block: '7' });
    writeFileSync(join(live, 'control.json'), '{"paused": false}\n');
    const before = readFileSync(join(live, 'journal.jsonl'), 'utf8');

    const dry = stageDryRunState(live, temp('keeper-root-'));
    expect(dry.startsWith(live)).toBe(false);
    expect(loadCursor(dry, 'arbitrum')).toEqual({ block: '7' });
    expect(readFileSync(join(dry, 'control.json'), 'utf8')).toBe('{"paused": false}\n');
    expect(readFileSync(join(dry, 'journal.jsonl'), 'utf8')).toBe(before);

    const j = openJournal(dry);
    j.append({ t: 'event', claimId: '0x02' });
    j.close();
    saveCursor(dry, 'arbitrum', { block: '9' });
    expect(readFileSync(join(live, 'journal.jsonl'), 'utf8')).toBe(before);
    expect(loadCursor(live, 'arbitrum')).toEqual({ block: '7' });
  });

  it('starts empty when the live directory has no state yet, and drops a partial last line', () => {
    const root = temp('keeper-root-');
    const empty = stageDryRunState(join(root, 'missing'), root);
    expect(readdirSync(empty)).toEqual([]);

    const live = temp('keeper-live-');
    writeFileSync(join(live, 'journal.jsonl'), '{"t":"event","at":1}\n{"t":"ev');
    const dry = stageDryRunState(live, root);
    expect(existsSync(join(dry, 'cursors'))).toBe(false);
    openJournal(dry).close();
    expect(readFileSync(join(dry, 'journal.jsonl'), 'utf8')).toBe('{"t":"event","at":1}\n');
    expect(readFileSync(join(live, 'journal.jsonl'), 'utf8')).toBe('{"t":"event","at":1}\n{"t":"ev');
  });
});
