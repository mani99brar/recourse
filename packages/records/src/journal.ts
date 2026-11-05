// Append-only JSONL journal. Every append is written and fsynced before it returns, so a row that
// `append` returned for survives a crash. A torn final line (a crash mid-write, never acknowledged)
// is cut off when the journal is next opened.

import { chmodSync, closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface JournalOptions {
  /** File mode for a new file, also enforced on open (default 0o600). */
  mode?: number;
}

export interface JournalReadResult<Row> {
  rows: Row[];
  /** Lines that did not parse. Never dropped silently. */
  corrupt: { line: number; text: string }[];
}

export class Journal<Row extends object> {
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly fd: number,
  ) {}

  static open<Row extends object>(path: string, options: JournalOptions = {}): Journal<Row> {
    const mode = options.mode ?? 0o600;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'a+', mode);
    chmodSync(path, mode);
    const text = readFileSync(path);
    if (text.length > 0 && text[text.length - 1] !== 0x0a) {
      const keep = text.lastIndexOf(0x0a) + 1;
      ftruncateSync(fd, keep);
      fsyncSync(fd);
    }
    return new Journal<Row>(path, fd);
  }

  /** Appends one row and fsyncs. Throws if the write fails; the caller must not go on then. */
  append(row: Row): void {
    if (this.closed) throw new Error('journal: closed');
    writeSync(this.fd, `${JSON.stringify(row)}\n`);
    fsyncSync(this.fd);
  }

  read(): JournalReadResult<Row> {
    return readJournal<Row>(this.path);
  }

  /** All rows in order. Throws if any line is corrupt, so a damaged journal is never half-read. */
  rows(): Row[] {
    const result = this.read();
    if (result.corrupt.length > 0) {
      throw new Error(`journal: ${result.corrupt.length} corrupt line(s), first at line ${result.corrupt[0]!.line}`);
    }
    return result.rows;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

export function readJournal<Row>(path: string): JournalReadResult<Row> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], corrupt: [] };
    throw error;
  }
  const lines = text.split('\n');
  // A final segment without a newline is a torn write that `open` has not cut yet.
  if (!text.endsWith('\n')) lines.pop();
  const rows: Row[] = [];
  const corrupt: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    try {
      rows.push(JSON.parse(raw) as Row);
    } catch {
      corrupt.push({ line: i + 1, text: raw.slice(0, 200) });
    }
  }
  return { rows, corrupt };
}
