// Operator control file: holds, releases, a global pause and extra send-pause windows. Written
// only by keeper-ctl (atomically), read by the keeper on every tick. It never touches the journal.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSendPauseWindows, type SendPauseWindow } from '@recourse/shared';

export const CONTROL_FILE = 'control.json';

export interface Control {
  /** No sends at all while true. */
  paused: boolean;
  /** Claim id -> unix ms the hold was placed. A held claim is watched but gets no calls. */
  holds: Record<string, number>;
  /** Claim id -> unix ms of the latest release; clears operator holds and any automatic hold older than it. */
  releases: Record<string, number>;
  /** Extra windows, same text form as SEND_PAUSE_WINDOWS items. */
  windows: string[];
  /**
   * Claim id -> unix ms the operator allowed expiry over a court ruling that has not reached
   * Hedera (keeper-ctl expire). Without it the keeper never expires such a claim itself.
   */
  expire: Record<string, number>;
  /** Read by nothing: there is no rebuild command (RUNBOOK.md has the journal steps). Still parsed, so older control files load. */
  rebuildAt?: number;
}

export function emptyControl(): Control {
  return { paused: false, holds: {}, releases: {}, windows: [], expire: {} };
}

export function controlPath(stateDir: string): string {
  return join(stateDir, CONTROL_FILE);
}

/** Reads the control file; a missing file means no holds and no pause. Throws on a corrupt file. */
export function readControl(stateDir: string): Control {
  const path = controlPath(stateDir);
  if (!existsSync(path)) return emptyControl();
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Control>;
  const c = emptyControl();
  c.paused = raw.paused === true;
  if (raw.holds && typeof raw.holds === 'object') c.holds = { ...raw.holds };
  if (raw.releases && typeof raw.releases === 'object') c.releases = { ...raw.releases };
  if (Array.isArray(raw.windows)) c.windows = raw.windows.filter((w): w is string => typeof w === 'string');
  if (raw.expire && typeof raw.expire === 'object') c.expire = { ...raw.expire };
  if (typeof raw.rebuildAt === 'number') c.rebuildAt = raw.rebuildAt;
  return c;
}

export function writeControl(stateDir: string, c: Control): void {
  const path = controlPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(c, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Windows from the control file, parsed; bad entries are reported, never applied. */
export function controlWindows(c: Control): { windows: SendPauseWindow[]; errors: string[] } {
  const windows: SendPauseWindow[] = [];
  const errors: string[] = [];
  for (const w of c.windows) {
    try {
      windows.push(...parseSendPauseWindows(w));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { windows, errors };
}

/** True when the operator holds the claim (a hold newer than its latest release). */
export function operatorHolds(c: Control, claimId: string): boolean {
  const held = c.holds[claimId.toLowerCase()];
  if (held === undefined) return false;
  const released = c.releases[claimId.toLowerCase()] ?? 0;
  return held > released;
}

/** True when the operator ran keeper-ctl expire for the claim: expiry may go over a pending ruling. */
export function expiryForced(c: Control, claimId: string): boolean {
  return c.expire[claimId.toLowerCase()] !== undefined;
}

/** True when an automatic hold placed at `heldAtMs` has been released since. */
export function releasedSince(c: Control, claimId: string, heldAtMs: number): boolean {
  const released = c.releases[claimId.toLowerCase()];
  return released !== undefined && released > heldAtMs;
}
