// Append-only JSON-lines journal. Every append is written and fsynced before it returns, so a
// record the caller has seen acknowledged survives a crash. A crash in the middle of a write can
// leave a partial last line; opening the journal drops that line (it was never acknowledged).
// A bad line anywhere else is corruption and is reported, never skipped silently.

import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const JOURNAL_FILE = 'journal.jsonl';

/** JSON-safe value: big integers and bytes must be stored as strings by the caller. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

/** One journal line. `t` names the record kind; `at` is the wall-clock time of the append in ms. */
export interface JournalRecord {
  t: string;
  at?: number;
  [key: string]: JsonValue | undefined;
}

export interface Journal {
  readonly dir: string;
  readonly path: string;
  /** Appends one record and fsyncs. Throws on a write failure. */
  append(record: JournalRecord): void;
  close(): void;
}

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

function serialise(record: JournalRecord): string {
  const line = JSON.stringify(record, (_k, v: unknown) => {
    if (typeof v === 'bigint') throw new JournalError('journal: bigint value; store it as a decimal string');
    if (v instanceof Uint8Array) throw new JournalError('journal: byte value; store it as hex');
    return v;
  });
  if (line.includes('\n')) throw new JournalError('journal: record serialised with a newline');
  return line + '\n';
}

/** Cuts a partial last line (no trailing newline) off the file. Returns true if it cut anything. */
function dropPartialTail(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, 'r+');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return false;
    // Walk back to the previous newline in chunks.
    const chunk = 4096;
    let pos = size;
    let cut = 0;
    while (pos > 0) {
      const start = Math.max(0, pos - chunk);
      const buf = Buffer.alloc(pos - start);
      readSync(fd, buf, 0, buf.length, start);
      const nl = buf.lastIndexOf(0x0a);
      if (nl >= 0) {
        cut = start + nl + 1;
        break;
      }
      pos = start;
    }
    ftruncateSync(fd, cut);
    fsyncSync(fd);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Opens (creating if needed) the journal in `dir` for appending. */
export function openJournal(dir: string, file: string = JOURNAL_FILE): Journal {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  dropPartialTail(path);
  const fd = openSync(path, 'a');
  let open = true;
  return {
    dir,
    path,
    append(record: JournalRecord) {
      if (!open) throw new JournalError('journal: closed');
      const line = serialise({ ...record, at: record.at ?? Date.now() });
      writeSync(fd, line);
      fsyncSync(fd);
    },
    close() {
      if (open) {
        open = false;
        closeSync(fd);
      }
    },
  };
}

/** Appends one record to an open journal. */
export function appendRecord(journal: Journal, record: JournalRecord): void {
  journal.append(record);
}

export interface ReplayResult {
  records: JournalRecord[];
  /** 1-based line numbers that did not parse as a record (corruption, not a crash tail). */
  badLines: number[];
  /** True when the file ended in a partial line, which replay ignores. */
  partialTail: boolean;
}

/** Reads every record of the journal in `dir`, oldest first. A missing journal is empty. */
export function replayJournal(dir: string, file: string = JOURNAL_FILE): ReplayResult {
  const path = join(dir, file);
  if (!existsSync(path)) return { records: [], badLines: [], partialTail: false };
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  // The last element is '' after a final newline, or a partial line after a crash mid-write.
  const partialTail = lines[lines.length - 1] !== '';
  lines.pop();
  const records: JournalRecord[] = [];
  const badLines: number[] = [];
  lines.forEach((line, i) => {
    if (line === '') {
      badLines.push(i + 1);
      return;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as JournalRecord).t !== 'string') {
        badLines.push(i + 1);
        return;
      }
      records.push(value as JournalRecord);
    } catch {
      badLines.push(i + 1);
    }
  });
  return { records, badLines, partialTail };
}
