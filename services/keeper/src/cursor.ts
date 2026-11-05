// Read cursors, one small JSON file per source. Writes go to a temp file that is fsynced and
// renamed over the old one, so a crash leaves either the old cursor or the new one.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from './journal.js';

const SOURCE = /^[A-Za-z0-9._-]+$/;

function cursorPath(dir: string, source: string): string {
  if (!SOURCE.test(source)) throw new RangeError(`cursor: bad source name ${source}`);
  return join(dir, 'cursors', `${source}.json`);
}

/** The saved cursor for `source`, or undefined when none was saved. */
export function loadCursor<T extends JsonValue>(dir: string, source: string): T | undefined {
  const path = cursorPath(dir, source);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Saves the cursor for `source` atomically. */
export function saveCursor<T extends JsonValue>(dir: string, source: string, cursor: T): void {
  const path = cursorPath(dir, source);
  const folder = join(dir, 'cursors');
  mkdirSync(folder, { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(cursor));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dfd = openSync(folder, 'r');
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}
