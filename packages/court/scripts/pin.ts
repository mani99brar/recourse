// Pins the court policy and the trial-case documents, each as one raw IPFS block, so the CID is the one
// computed locally (POLICY.cid, the cids in fixtures/trial/*/case.json) wherever it is pinned.
//
//   tsx scripts/pin.ts            write one CAR per document to .car/ (gitignored) and list CIDs
//   tsx scripts/pin.ts --upload   also import each CAR into the pinning service
//   tsx scripts/pin.ts --verify   fetch each CID through the gateways and check its SHA-256
//
// Upload uses the Kubo-compatible RPC `dag/import` endpoint at IPFS_PIN_API_URL with the bearer token
// IPFS_PIN_API_KEY (the pinning provider's IPFS RPC). The service must report the same root CID, or the
// script stops. Gateways checked: IPFS_GATEWAY_URL and the court UI's default gateway.
//
// Nothing is served or referenced as pinned until --verify passes for it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, type Hex } from 'viem';
import { carOf, rawCidOf } from '../src/cid.js';
import { POLICY } from '../src/policy.js';
import { TRIAL_CASES } from '../src/trial.js';
import { PACKAGE_ROOT } from './fixtures.js';

const COURT_UI_GATEWAY = 'https://cdn.kleros.link';

interface Doc {
  label: string;
  path: string;
  bytes: Uint8Array;
  cid: string;
  sha256: Hex;
}

function docs(): Doc[] {
  const files = [POLICY.path];
  for (const c of TRIAL_CASES) {
    for (const k of ['asked', 'shown', 'approval', 'ordered', 'packed', 'arrived', 'precheck-result']) {
      files.push(`fixtures/trial/${c.id}/${k}.json`);
    }
  }
  return files.map((rel) => {
    const bytes = new Uint8Array(readFileSync(join(PACKAGE_ROOT, rel)));
    return { label: rel, path: rel, bytes, cid: rawCidOf(bytes), sha256: sha256(bytes) };
  });
}

async function upload(d: Doc, car: Uint8Array): Promise<void> {
  const base = process.env.IPFS_PIN_API_URL;
  const key = process.env.IPFS_PIN_API_KEY;
  if (!base || !key) throw new Error('IPFS_PIN_API_URL and IPFS_PIN_API_KEY must be set for --upload');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(car)], { type: 'application/vnd.ipld.car' }), `${d.cid}.car`);
  const res = await fetch(`${base.replace(/\/$/, '')}/api/v0/dag/import?pin-roots=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${d.label}: upload failed with HTTP ${res.status}`);
  if (!text.includes(d.cid)) throw new Error(`${d.label}: the service did not report root ${d.cid}`);
}

async function verify(d: Doc): Promise<string[]> {
  const gateways = [process.env.IPFS_GATEWAY_URL, COURT_UI_GATEWAY].filter((g): g is string => !!g);
  const out: string[] = [];
  for (const g of gateways) {
    const host = new URL(g).host;
    try {
      const res = await fetch(`${g.replace(/\/$/, '')}/ipfs/${d.cid}`, { signal: AbortSignal.timeout(60_000) });
      const body = new Uint8Array(await res.arrayBuffer());
      const ok = res.ok && sha256(body) === d.sha256;
      out.push(`${host}: ${ok ? 'ok' : `mismatch (HTTP ${res.status}, ${body.length} bytes)`}`);
    } catch (e) {
      out.push(`${host}: ${(e as Error).name}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const dir = join(PACKAGE_ROOT, '.car');
  mkdirSync(dir, { recursive: true });
  for (const d of docs()) {
    const car = carOf(d.bytes);
    writeFileSync(join(dir, `${d.cid}.car`), car);
    let line = `${d.cid}  ${d.sha256}  ${d.label}`;
    if (process.argv.includes('--upload')) {
      await upload(d, car);
      line += '  uploaded';
    }
    if (process.argv.includes('--verify')) line += `  ${(await verify(d)).join(', ')}`;
    console.log(line);
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
