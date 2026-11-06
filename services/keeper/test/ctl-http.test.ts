// keeper-ctl writes only the control file; the HTTP surface is read-only and checks its input.

import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { controlWindows, expiryForced, operatorHolds, readControl, releasedSince } from '../src/control.js';
import { runCtl } from '../src/ctl.js';
import { createKeeperApp, listenKeeper } from '../src/http.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ID = `0x${'ab'.repeat(32)}`;

function env() {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-ctl-'));
  dirs.push(dir);
  return { dir, env: { KEEPER_STATE_DIR: dir, KEEPER_PORT: '1' } };
}

describe('keeper-ctl', () => {
  it('pauses, resumes, holds and releases through the control file', async () => {
    const { dir, env: e } = env();
    expect((await runCtl(['pause'], e)).code).toBe(0);
    expect(readControl(dir).paused).toBe(true);
    await runCtl(['resume'], e);
    expect(readControl(dir).paused).toBe(false);
    await runCtl(['hold', ID.toUpperCase().replace('0X', '0x')], e);
    expect(operatorHolds(readControl(dir), ID)).toBe(true);
    const heldAt = Date.now() - 1;
    await new Promise((r) => setTimeout(r, 5));
    await runCtl(['release', ID], e);
    expect(operatorHolds(readControl(dir), ID)).toBe(false);
    expect(releasedSince(readControl(dir), ID, heldAt)).toBe(true);
  });

  it('expire allows expiry over a pending ruling for that claim only', async () => {
    const { dir, env: e } = env();
    expect(expiryForced(readControl(dir), ID)).toBe(false);
    expect((await runCtl(['expire', ID], e)).out).toMatch(/ruling is then ignored/);
    expect(expiryForced(readControl(dir), ID)).toBe(true);
    expect(expiryForced(readControl(dir), `0x${'cd'.repeat(32)}`)).toBe(false);
  });

  it('adds a pause window only when it parses', async () => {
    const { dir, env: e } = env();
    await runCtl(['window', 'add', 'hedera@2026-11-06T17:45:00Z/2026-11-06T18:45:00Z'], e);
    expect(controlWindows(readControl(dir)).windows).toEqual([{ chain: 'hedera', from: 1793987100, to: 1793990700 }]);
    await expect(runCtl(['window', 'add', 'hedera@tomorrow/later'], e)).rejects.toThrow(/SEND_PAUSE_WINDOWS/);
    expect(readControl(dir).windows).toHaveLength(1);
    await runCtl(['window', 'clear'], e);
    expect(readControl(dir).windows).toEqual([]);
  });

  it('rejects a malformed claim id and prints usage for an unknown command', async () => {
    const { env: e } = env();
    await expect(runCtl(['hold', '0x12'], e)).rejects.toThrow(/claim id/);
    expect((await runCtl(['nope'], e)).code).toBe(2);
  });

  it('status reads the loopback health endpoint', async () => {
    const { env: e } = env();
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await runCtl(['status'], e, fake);
    expect(calls).toEqual(['http://127.0.0.1:1/health']);
    expect(r.out).toContain('"ok":true');
  });
});

describe('http', () => {
  it('serves health and claims, 400 on a bad id, 404 on an unknown one', async () => {
    const app = createKeeperApp({ health: () => ({ ok: true }), claim: (id) => (id === ID ? { claimId: id, phase: 'Sent' } : undefined) });
    const server = await listenKeeper(app, 0);
    const port = (server.address() as AddressInfo).port;
    try {
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
      expect(await (await fetch(`${base}/claims/${ID}`)).json()).toEqual({ claimId: ID, phase: 'Sent' });
      expect((await fetch(`${base}/claims/0x12`)).status).toBe(400);
      expect((await fetch(`${base}/claims/0x${'cd'.repeat(32)}`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('answers /health with the status the source gives, and still sends the body', async () => {
    let status = 503;
    const app = createKeeperApp({ health: () => ({ ok: status === 200 }), healthStatus: () => status, claim: () => undefined });
    const server = await listenKeeper(app, 0);
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false });
      status = 200;
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
