// One docket process per state dir: a pid file taken with exclusive create. A stale file (its pid
// is gone) is replaced; a live one makes the second process exit.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class LockHeldError extends Error {
  constructor(readonly pid: number) {
    super(`another docket process holds the lock (pid ${pid})`);
    this.name = 'LockHeldError';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (readFileSync(path, 'utf8') === String(process.pid)) rmSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new LockHeldError(pid);
      rmSync(path, { force: true });
    }
  }
  throw new Error('could not take the docket lock');
}
