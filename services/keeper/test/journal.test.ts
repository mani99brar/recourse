import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendRecord, JOURNAL_FILE, openJournal, replayJournal } from '../src/journal.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'keeper-journal-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('journal', () => {
  it('appends records in order and replays them', () => {
    const dir = tmp();
    const j = openJournal(dir);
    appendRecord(j, { t: 'event', key: 'a' });
    j.append({ t: 'state', key: 'b', at: 5 });
    j.close();
    const r = replayJournal(dir);
    expect(r.records.map((x) => x.key)).toEqual(['a', 'b']);
    expect(r.records[1]!.at).toBe(5);
    expect(typeof r.records[0]!.at).toBe('number');
    expect(r.badLines).toEqual([]);
    expect(r.partialTail).toBe(false);
  });

  it('a missing journal replays empty', () => {
    expect(replayJournal(tmp()).records).toEqual([]);
  });

  it('drops a partial last line left by a crash, on replay and on reopen', () => {
    const dir = tmp();
    const j = openJournal(dir);
    j.append({ t: 'event', key: 'whole' });
    j.close();
    appendFileSync(join(dir, JOURNAL_FILE), '{"t":"intent","key":"ha');
    const before = replayJournal(dir);
    expect(before.partialTail).toBe(true);
    expect(before.records.map((x) => x.key)).toEqual(['whole']);
    const j2 = openJournal(dir);
    j2.append({ t: 'event', key: 'next' });
    j2.close();
    const after = replayJournal(dir);
    expect(after.records.map((x) => x.key)).toEqual(['whole', 'next']);
    expect(after.badLines).toEqual([]);
    expect(readFileSync(join(dir, JOURNAL_FILE), 'utf8').endsWith('\n')).toBe(true);
  });

  it('reports a corrupt line in the middle instead of skipping it silently', () => {
    const dir = tmp();
    writeFileSync(join(dir, JOURNAL_FILE), '{"t":"event"}\nnot json\n{"t":"state"}\n');
    const r = replayJournal(dir);
    expect(r.records).toHaveLength(2);
    expect(r.badLines).toEqual([2]);
  });

  it('refuses values that do not survive JSON', () => {
    const j = openJournal(tmp());
    expect(() => j.append({ t: 'event', n: 1n } as never)).toThrow(/bigint/);
    expect(() => j.append({ t: 'event', b: new Uint8Array(2) } as never)).toThrow(/hex/);
    j.close();
  });
});
