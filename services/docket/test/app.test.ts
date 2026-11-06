import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, memoryLogger, readJournal } from '@recourse/records';
import { afterEach, describe, expect, it } from 'vitest';
import { CIRCLE_VAULT_TOKEN, vaultTokenOf, type VaultToken } from '@recourse/shared';
import { createDocketApp } from '../src/app.js';
import { Docket, type JournalRow } from '../src/docket.js';
import { LocalStore } from '../src/store/local.js';
import { E, NOV, PLATFORM, SHOP, cid } from './helpers.js';

const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function boot(vaultToken?: VaultToken) {
  const dir = mkdtempSync(join(tmpdir(), 'docket-app-'));
  const store = LocalStore.open(join(dir, 'store.jsonl'));
  const path = join(dir, 'docket.jsonl');
  const docket = new Docket({ store, journal: Journal.open<JournalRow>(path), history: readJournal<JournalRow>(path).rows, now: () => NOV + 100_000, log: memoryLogger() });
  const app = createDocketApp({ docket, store: 'local', rate: { publishThreshold: 20, sampleMode: true, z: 1.96 }, ...(vaultToken ? { vaultToken } : {}) });
  const server = app.listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { docket, base };
}

describe('docket http', () => {
  it('answers write status for every state, on the local store', async () => {
    const { docket, base } = await boot();
    docket.ingest([E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1), E.filed(2), E.filed(3), E.uncontested(3)]);
    const get = async (id: string) => (await fetch(`${base}/write-status/${id}`)).json();
    expect(await get(cid(1))).toMatchObject({ writeStatus: 'pending', store: 'local' });
    await docket.flush();
    expect(await get(cid(1))).toMatchObject({ writeStatus: 'written', store: 'local', entityKey: `local:${cid(1)}` });
    expect(await get(cid(2))).toMatchObject({ writeStatus: 'none' });
    expect(await get(cid(3))).toMatchObject({ writeStatus: 'none' });
    const missing = await fetch(`${base}/write-status/${cid(99)}`);
    expect(missing.status).toBe(404);
    expect((await fetch(`${base}/write-status/nonsense`)).status).toBe(400);
  });

  it('serves cases, counts, rates and health from the same state', async () => {
    const { docket, base } = await boot();
    const events = [];
    for (let i = 1; i <= 4; i++) events.push(E.filed(i), E.precheck(i, 2, 1), E.ruling(i, i === 4 ? 2 : 1, 1, NOV + 7000 + i));
    events.push(E.filed(5), E.uncontested(5));
    docket.ingest(events);
    await docket.flush();
    const cases = await (await fetch(`${base}/docket/cases?platform=${PLATFORM}`)).json();
    expect(cases.total).toBe(4);
    expect(cases.rows[0]).toHaveProperty('entityKey');
    expect(JSON.stringify(cases)).not.toMatch(/complaint|buyer/i);
    const counts = await (await fetch(`${base}/docket/counts?month=2026-11`)).json();
    expect(counts.rows).toHaveLength(1);
    expect(counts.rows[0]).toMatchObject({ filed: 5, ruled: 4, closedUncontested: 1 });

    const rates = await (await fetch(`${base}/rates?platform=${PLATFORM}`)).json();
    const r = rates.rates.find((x: { kind: string }) => x.kind === 'platform_fault');
    expect(r).toMatchObject({ units: 4, hits: 3, published: false, sample: true, closedUncontested: 1 });
    expect((await fetch(`${base}/rates`)).status).toBe(400);
    expect((await fetch(`${base}/rates?shop=${SHOP}&platform=${PLATFORM}`)).status).toBe(400);

    const health = await (await fetch(`${base}/health`)).json();
    expect(health).toMatchObject({ ok: true, store: 'local', rateConfig: { publishThreshold: 20, sampleMode: true, z: 1.96 } });
    expect(cases.vaultToken).toBeNull();
    expect(health.vaultToken).toBeNull();
  });

  it('names the vault token beside case amounts, and leaves the rows as written', async () => {
    const mock = vaultTokenOf({ usdc: { mode: 'mock', address: '0x1111111111111111111111111111111111111111', decimals: 6, tokenId: null } });
    for (const token of [CIRCLE_VAULT_TOKEN, mock]) {
      const { docket, base } = await boot(token);
      docket.ingest([E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1)]);
      await docket.flush();
      const cases = await (await fetch(`${base}/docket/cases`)).json();
      expect(cases.vaultToken).toEqual(token);
      expect(Object.keys(cases.rows[0])).not.toContain('vaultToken');
      expect((await (await fetch(`${base}/health`)).json()).vaultToken.label).toBe(token.label);
    }
  });
});
