// A lock file for commands that write a journal a second process may also write: it holds the
// owner's pid, so a lock left by a process that died is taken over. One operator on one host; not
// a general mutex.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerOf(path: string): number | null {
  try {
    return Number(readFileSync(path, 'utf8').trim());
  } catch {
    return null;
  }
}

export class LockBusyError extends Error {
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`${path} is held by pid ${pid}; wait for that command to finish`);
    this.name = 'LockBusyError';
  }
}

/** Runs `fn` holding the lock at `path`; throws LockBusyError when a live process holds it. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 3) throw error;
      const pid = ownerOf(path);
      if (pid !== null && alive(pid)) throw new LockBusyError(path, pid);
      // Stale: remove it only if it still names the same dead owner.
      if (ownerOf(path) === pid) {
        try {
          unlinkSync(path);
        } catch {
          // Someone else removed it first.
        }
      }
    }
  }
  try {
    return await fn();
  } finally {
    if (ownerOf(path) === process.pid) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  }
}
