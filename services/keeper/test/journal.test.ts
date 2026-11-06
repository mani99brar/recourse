import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendRecord, JOURNAL_FILE, openJournal, replayJournal, streamJournal } from '../src/journal.js';

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

describe('journal streaming and rewrite', () => {
  it('streams the same records, bad lines and partial tail as a whole-file read, whatever the chunk size', () => {
    const dir = tmp();
    const lines = [
      JSON.stringify({ t: 'event', key: 'a', text: 'é'.repeat(300) }),
      'not json',
      JSON.stringify({ t: 'state', key: 'b', text: '€'.repeat(1000) }),
      '',
      JSON.stringify({ t: 'intent', key: 'c' }),
    ];
    writeFileSync(join(dir, JOURNAL_FILE), lines.join('\n') + '\n{"t":"result","id":"cut sh');
    const whole = replayJournal(dir);
    expect(whole.records.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(whole.badLines).toEqual([2, 4]);
    expect(whole.partialTail).toBe(true);
    for (const chunk of [1, 7, 64, 4096]) {
      const got: unknown[] = [];
      const r = streamJournal(dir, JOURNAL_FILE, (rec) => got.push(rec), chunk);
      expect(got).toEqual(whole.records);
      expect(r.badLines).toEqual(whole.badLines);
      expect(r.partialTail).toBe(true);
    }
  });

  it('rewrite swaps in the new records atomically, keeps the old file as .prev and appends to the new one', () => {
    const dir = tmp();
    const j = openJournal(dir);
    for (let i = 0; i < 100; i++) j.append({ t: 'event', key: `e${i}` });
    const oldSize = j.size!();
    j.rewrite!([{ t: 'state', key: 'only' }]);
    j.append({ t: 'event', key: 'after' });
    j.close();
    expect(replayJournal(dir).records.map((r) => r.key)).toEqual(['only', 'after']);
    expect(statSync(join(dir, `${JOURNAL_FILE}.prev`)).size).toBe(oldSize);
    expect(replayJournal(dir, `${JOURNAL_FILE}.prev`).records).toHaveLength(100);
    expect(existsSync(join(dir, `${JOURNAL_FILE}.compact`))).toBe(false);
  });

  it('a record that cannot be written stops the rewrite before the journal changes', () => {
    const dir = tmp();
    const j = openJournal(dir);
    j.append({ t: 'event', key: 'kept' });
    expect(() => j.rewrite!([{ t: 'state', n: 1n } as never])).toThrow(/bigint/);
    j.append({ t: 'event', key: 'still appends' });
    j.close();
    expect(replayJournal(dir).records.map((r) => r.key)).toEqual(['kept', 'still appends']);
    expect(existsSync(join(dir, `${JOURNAL_FILE}.compact`))).toBe(false);
  });
});
