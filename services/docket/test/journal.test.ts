import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, LockHeldError } from '../src/lock.js';
import { MemoryArkivIo } from './fakes.js';
import { E, cid, rig } from './helpers.js';

const caseEntities = (io: MemoryArkivIo) => [...io.entities.values()].filter((e) => e.schema === 'case');
const countEntities = (io: MemoryArkivIo) => [...io.entities.values()].filter((e) => e.schema === 'monthly-count');

describe('docket journal', () => {
  it('writes one case and one count per claim set, and replaying the same logs changes nothing', async () => {
    const r = rig();
    const events = [E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1), E.filed(2), E.uncontested(2)];
    expect(r.docket.ingest(events)).toBe(5);
    await r.docket.flush();
    expect(caseEntities(r.io)).toHaveLength(1);
    expect(countEntities(r.io)).toHaveLength(1);
    const sentBefore = r.io.sent.length;

    // the same logs again, in the same process and after a restart
    expect(r.docket.ingest(events)).toBe(0);
    await r.docket.flush();
    const again = r.reopen();
    expect(again.ingest(events)).toBe(0);
    await again.flush();
    expect(r.io.sent.length).toBe(sentBefore);
    expect(again.writeStatus(cid(1))).toMatchObject({ writeStatus: 'written', store: 'arkiv' });
    expect(again.writeStatus(cid(2))).toMatchObject({ writeStatus: 'none' });
  });

  it('walks a claim through none, pending, written and patches the settlement', async () => {
    const r = rig();
    r.docket.ingest([E.filed(1), E.precheck(1, 2, 1)]);
    expect(r.docket.writeStatus(cid(1))?.writeStatus).toBe('none');
    r.docket.ingest([E.ruling(1, 1)]);
    expect(r.docket.writeStatus(cid(1))?.writeStatus).toBe('pending');
    await r.docket.flush();
    const written = r.docket.writeStatus(cid(1))!;
    expect(written.writeStatus).toBe('written');
    expect(written.entityKey).toMatch(/^0x/);
    expect(written.settlementPending).toBe(false);

    r.docket.ingest([E.applied(1, '2500000', '500000'), E.settled(1)]);
    expect(r.docket.writeStatus(cid(1))?.settlementPending).toBe(true);
    await r.docket.flush();
    const done = r.docket.writeStatus(cid(1))!;
    expect(done.settlementPending).toBe(false);
    const [entity] = caseEntities(r.io);
    expect(entity!.values.toShopUsdc).toBe(3_000_000n); // paid + refund, never the owed amount
    expect(entity!.values.settledAt).toBeGreaterThan(0n);
    expect(r.io.sent.filter((s) => s.op === 'patch' && s.schema === 'case')).toHaveLength(1);
  });

  it('carries settlement fields in the create when they land before the entity is written', async () => {
    const r = rig();
    r.docket.ingest([E.filed(1), E.precheck(1, 1, 1), E.ruling(1, 1), E.applied(1, '3000000'), E.settled(1)]);
    await r.docket.flush();
    expect(r.io.sent.filter((s) => s.schema === 'case')).toEqual([expect.objectContaining({ op: 'create' })]);
    expect(caseEntities(r.io)[0]!.values.toShopUsdc).toBe(3_000_000n);
  });

  it('writes a case for a second refusal with the pre-check answer as the outcome, and none for a first refusal', async () => {
    const r = rig();
    r.docket.ingest([E.filed(1), E.precheck(1, 2, 2), E.ruling(1, 0, 2), E.filed(2), E.ruling(2, 0, 1)]);
    await r.docket.flush();
    const [e] = caseEntities(r.io);
    expect(e!.values).toMatchObject({ ruling: 0n, outcome: 2n, unresolved: false, zeroTwice: true });
    expect(caseEntities(r.io)).toHaveLength(1);
    expect(r.docket.writeStatus(cid(2))?.writeStatus).toBe('none');
  });

  it('recovers a create whose response was lost without writing a second entity', async () => {
    const r = rig();
    r.docket.ingest([E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1)]);
    r.io.loseResponse = true; // the entity lands, the call throws, and the process then dies
    await r.docket.flush();
    expect(caseEntities(r.io)).toHaveLength(1);
    // simulate a crash right after the intent: rebuild the journal without the failure row
    const restarted = r.reopen();
    r.clock.t += 700;
    await restarted.flush();
    expect(caseEntities(r.io)).toHaveLength(1);
    expect(restarted.writeStatus(cid(1))).toMatchObject({ writeStatus: 'written' });
  });

  it('adopts an entity found by owner and claim id when the journal stops at an intent', async () => {
    const r = rig();
    r.docket.ingest([E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1)]);
    await r.docket.flush();
    // Drop the done row: a crash between the store answering and the journal append.
    const { readFileSync, writeFileSync } = await import('node:fs');
    const lines = readFileSync(r.journalPath, 'utf8').trim().split('\n');
    const kept = lines.filter((l) => !(l.includes('"target":"case"') && (l.includes('"phase":"done"') || l.includes('"phase":"sent"'))));
    writeFileSync(r.journalPath, `${kept.join('\n')}\n`);
    const restarted = r.reopen();
    expect(restarted.writeStatus(cid(1))?.writeStatus).toBe('pending');
    await restarted.flush();
    expect(caseEntities(r.io)).toHaveLength(1);
    expect(restarted.writeStatus(cid(1))?.writeStatus).toBe('written');
  });

  it('waits while the sent transaction is still pending', async () => {
    const r = rig();
    r.docket.ingest([E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1)]);
    await r.docket.flush();
    const { readFileSync, writeFileSync } = await import('node:fs');
    const lines = readFileSync(r.journalPath, 'utf8').trim().split('\n');
    const sentLine = lines.find((l) => l.includes('"target":"case"') && l.includes('"phase":"sent"'))!;
    const txHash = JSON.parse(sentLine).txHash as string;
    // forget the entity (as if the node has not indexed it yet) and keep the pending tx
    const kept = lines.filter((l) => !(l.includes('"target":"case"') && l.includes('"phase":"done"')));
    writeFileSync(r.journalPath, `${kept.join('\n')}\n`);
    r.io.txStates.set(txHash, 'pending');
    r.io.entities.clear();
    const restarted = r.reopen();
    await restarted.flush();
    expect(caseEntities(r.io)).toHaveLength(0); // no second write while the first may still land
    r.io.txStates.set(txHash, 'failed');
    await restarted.flush();
    expect(caseEntities(r.io)).toHaveLength(1);
  });

  it('waits while the sent transaction cannot be looked up, or has landed but is not indexed yet', async () => {
    const r = rig();
    r.docket.ingest([E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1)]);
    await r.docket.flush();
    const { readFileSync, writeFileSync } = await import('node:fs');
    const lines = readFileSync(r.journalPath, 'utf8').trim().split('\n');
    const sentLine = lines.find((l) => l.includes('"target":"case"') && l.includes('"phase":"sent"'))!;
    const { txHash, entityKey } = JSON.parse(sentLine) as { txHash: string; entityKey: string };
    // a crash between the store answering and the done row, then a restart while the node lags
    writeFileSync(r.journalPath, `${lines.filter((l) => !(l.includes('"target":"case"') && l.includes('"phase":"done"'))).join('\n')}\n`);
    const landed = new Map(r.io.entities);
    r.io.entities.clear();
    r.io.txStates.set(txHash, 'unknown'); // the receipt lookup errors
    const restarted = r.reopen();
    await restarted.flush();
    expect(caseEntities(r.io)).toHaveLength(0);
    expect(restarted.writeStatus(cid(1))?.writeStatus).toBe('pending');

    r.io.txStates.set(txHash, 'success'); // it landed, but queries do not show it yet
    await restarted.flush();
    expect(caseEntities(r.io)).toHaveLength(0);

    for (const [k, v] of landed) r.io.entities.set(k, v); // indexed now
    await restarted.flush();
    expect(caseEntities(r.io)).toHaveLength(1);
    expect(restarted.writeStatus(cid(1))).toMatchObject({ writeStatus: 'written', entityKey });
  });

  it('keeps counts in step with the claim set as write status changes', async () => {
    const r = rig();
    r.docket.ingest([E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1), E.filed(2)]);
    r.io.failWith.push(new Error('socket hang up')); // the case write fails once
    await r.docket.flush();
    let [row] = r.docket.writtenCounts();
    expect(row!.row).toMatchObject({ filed: 2, ruledNotWritten: 1, open: 1, ruled: 0 });
    r.clock.t += 700;
    await r.docket.flush();
    [row] = r.docket.writtenCounts();
    expect(row!.row).toMatchObject({ filed: 2, ruledNotWritten: 0, ruled: 1, open: 1 });
    expect(countEntities(r.io)).toHaveLength(1);
  });
});

describe('docket lock', () => {
  it('refuses a second holder and releases cleanly', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'docket-lock-')), 'docket.lock');
    const release = acquireLock(path);
    expect(() => acquireLock(path)).toThrow(LockHeldError);
    release();
    const again = acquireLock(path);
    again();
  });

  it('replaces a lock left by a dead process', async () => {
    const { writeFileSync } = await import('node:fs');
    const path = join(mkdtempSync(join(tmpdir(), 'docket-lock-')), 'docket.lock');
    writeFileSync(path, '2147483646');
    expect(() => acquireLock(path)()).not.toThrow();
  });
});
