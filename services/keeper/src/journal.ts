// Append-only JSON-lines journal. Every append is written and fsynced before it returns, so a
// record the caller has seen acknowledged survives a crash. A crash in the middle of a write can
// leave a partial last line; opening the journal drops that line (it was never acknowledged).
// A bad line anywhere else is corruption and is reported, never skipped silently.
//
// Replay streams the file line by line, so start-up never holds the whole file as one string.
// `rewrite` replaces the journal with a compacted one atomically: the new file is written and
// fsynced beside it, the old one is kept as `<file>.prev`, then a rename swaps them, so a crash
// at any point leaves either the old journal or the new one, whole.

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
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
  /** Bytes in the journal file now. */
  size?(): number;
  /**
   * Replaces the whole journal with these records, atomically (temp file, fsync, rename, fsync of
   * the folder), keeps the old file as `<file>.prev`, and appends to the new file from then on.
   */
  rewrite?(records: Iterable<JournalRecord>): void;
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

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some file systems refuse fsync on a directory; the rename itself is still atomic.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Opens (creating if needed) the journal in `dir` for appending. */
export function openJournal(dir: string, file: string = JOURNAL_FILE): Journal {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  dropPartialTail(path);
  let fd = openSync(path, 'a');
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
    size() {
      return fstatSync(fd).size;
    },
    rewrite(records: Iterable<JournalRecord>) {
      if (!open) throw new JournalError('journal: closed');
      const tmp = `${path}.compact`;
      const prev = `${path}.prev`;
      const out = openSync(tmp, 'w');
      try {
        // Serialise everything first: a record that cannot be written stops the rewrite before
        // anything on disk changes.
        let buf = '';
        for (const r of records) {
          buf += serialise({ ...r, at: r.at ?? Date.now() });
          if (buf.length >= 1 << 20) {
            writeSync(out, buf);
            buf = '';
          }
        }
        if (buf !== '') writeSync(out, buf);
        fsyncSync(out);
      } catch (err) {
        closeSync(out);
        unlinkSync(tmp);
        throw err;
      }
      closeSync(out);
      // Keep the old journal under a second name (a hard link: no copy, and no moment without
      // a journal at `path`), then swap the new one in.
      try {
        if (existsSync(prev)) unlinkSync(prev);
        linkSync(path, prev);
      } catch {
        // No backup on a file system without hard links; the swap below is still atomic.
      }
      renameSync(tmp, path);
      fsyncDir(dir);
      const next = openSync(path, 'a');
      closeSync(fd);
      fd = next;
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
  const records: JournalRecord[] = [];
  const r = streamJournal(dir, file, (rec) => {
    records.push(rec);
  });
  return { records, badLines: r.badLines, partialTail: r.partialTail };
}

function parseLine(line: string): JournalRecord | undefined {
  if (line === '') return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as JournalRecord).t !== 'string') return undefined;
    return value as JournalRecord;
  } catch {
    return undefined;
  }
}

/**
 * Hands every record of the journal in `dir` to `onRecord`, oldest first, reading the file in
 * chunks: memory holds one chunk and one line at a time, never the whole file. Same rules as
 * `replayJournal`: a partial last line is ignored, any other bad line is reported by number.
 */
export function streamJournal(
  dir: string,
  file: string,
  onRecord: (record: JournalRecord, line: number) => void,
  chunkBytes = 1 << 20,
): { badLines: number[]; partialTail: boolean; records: number } {
  const path = join(dir, file);
  if (!existsSync(path)) return { badLines: [], partialTail: false, records: 0 };
  const badLines: number[] = [];
  let lineNo = 0;
  let count = 0;
  const decoder = new TextDecoder('utf-8');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(chunkBytes);
    let carry: Buffer[] = [];
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      pos += n;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl < 0 || nl >= n) break;
        const piece = buf.subarray(start, nl);
        const bytes = carry.length > 0 ? Buffer.concat([...carry, piece]) : piece;
        carry = [];
        lineNo += 1;
        const rec = parseLine(decoder.decode(bytes));
        if (rec === undefined) badLines.push(lineNo);
        else {
          count += 1;
          onRecord(rec, lineNo);
        }
        start = nl + 1;
      }
      if (start < n) carry.push(Buffer.from(buf.subarray(start, n)));
    }
    // Bytes after the last newline are a write cut short by a crash: never acknowledged.
    const partialTail = carry.some((b) => b.length > 0);
    return { badLines, partialTail, records: count };
  } finally {
    closeSync(fd);
  }
}
