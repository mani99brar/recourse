// The pre-check over the shared pin client on a file:// content store (as this host runs it), and
// the hand-off to the keeper: the keeper's evidence assembler reads the same store and gets the
// result document and every held record, each matching its hash.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceAssembler, type BuildEvidence } from '@recourse/keeper';
import { fetchDocument, hashOfCid, ipfsOptionsFromEnv, openPinClient } from '@recourse/records';
import { encodeClaimToCourt, sha256 } from '@recourse/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { PinnedDocStore } from '../src/docs.js';
import { cleanupRigs, makeRig, setupClaim } from './support.js';

const dirs: string[] = [];
afterEach(() => {
  cleanupRigs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('shared pin store', () => {
  it('pins the result document to the host store, where the keeper reads it back with the held records', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'precheck-ipfs-'));
    dirs.push(storeDir);
    const env = { IPFS_PIN_API_URL: `file://${storeDir}` };
    const pins = openPinClient(env);

    const rig = makeRig();
    const { claimId, refs } = setupClaim(rig, { later: true });
    // The records client pinned every record document to this store when it wrote it.
    for (const bytes of rig.world.gatewayDocs.values()) await pins.pin(bytes);

    const docs = new PinnedDocStore({ source: { fetch: (cid) => pins.fetch(cid) }, pinClient: { pin: async (b) => (await pins.pin(b)).cid } });
    const svc = await rig.start({ docs });
    await svc.tick();
    const v = svc.result(claimId)!;
    expect(v.state).toBe('intent');
    expect(v.cid).toBeDefined();
    const doc = await pins.fetch(v.cid!);
    expect(sha256(doc)).toBe(v.packHash);
    svc.close();

    // The keeper side: fetch-only options from the same environment, no pin provider needed.
    const options = ipfsOptionsFromEnv(env);
    const seen: { records: number; precheckCid?: string } = { records: 0 };
    const build: BuildEvidence = (input) => {
      seen.records = input.records.length;
      seen.precheckCid = input.precheck.cid;
      for (const r of input.records) expect(r.cid).toBeDefined();
      return { evidence: 'ok', sha256: sha256(new TextEncoder().encode('ok')) };
    };
    const assembler = evidenceAssembler({
      fetchDoc: async (cid) => {
        const h = hashOfCid(cid);
        return h ? fetchDocument(cid, h, options).catch(() => null) : null;
      },
      rawCidOfHash: () => v.cid!,
      build,
    });
    const payload = encodeClaimToCourt({
      version: 1,
      claimId,
      platform: '0x00000000000000000000000000000000000003a0',
      shop: '0x00000000000000000000000000000000000005a0',
      gap: Number(v.gap) as 0,
      answer: Number(v.answer) as 0,
      refs,
      packHash: v.packHash!,
      basketUsdc: 1n,
      netLossUsdc: 1n,
      filedAt: 1n,
    });
    const out = await assembler.build({ claimId, payload, attempt: 1, externalId: 1n });
    expect(out).toMatchObject({ ok: true });
    expect(seen.precheckCid).toBe(v.cid);
    expect(seen.records).toBe(v.slots.filter((s) => s.outcome === 'held').length);
    expect(seen.records).toBeGreaterThan(0);
  });
});
