import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockBusyError, withFileLock } from '../src/lock.js';

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'lock-')), 'sub', 'journal.lock');

describe('file lock', () => {
  it('holds the lock while running and removes it after, even on error', async () => {
    const path = lockPath();
    await withFileLock(path, async () => {
      expect(existsSync(path)).toBe(true);
    });
    expect(existsSync(path)).toBe(false);
    await expect(withFileLock(path, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(existsSync(path)).toBe(false);
  });

  it('refuses while a live process holds it', async () => {
    const path = lockPath();
    await withFileLock(path, async () => {
      await expect(withFileLock(path, async () => 1)).rejects.toBeInstanceOf(LockBusyError);
    });
  });

  it('takes over a lock left by a process that died', async () => {
    const path = lockPath();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    await withFileLock(path, async () => undefined); // creates the directory
    writeFileSync(path, `${dead.stdout}\n`);
    expect(await withFileLock(path, async () => 'ran')).toBe('ran');
    expect(existsSync(path)).toBe(false);
  });
});
