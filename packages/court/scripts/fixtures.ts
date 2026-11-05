// Generated fixture files of this package, as one map from path (relative to the package root) to bytes.
//   tsx scripts/fixtures.ts           write them
//   tsx scripts/fixtures.ts --check   exit 1 if any file on disk differs
// `template/golden.json` is what the contract tests read to prove `previewTemplate` equals `buildTemplate`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stringToHex, type Hex } from 'viem';
import { POLICY } from '../src/policy.js';
import { TEMPLATE_VARIANTS, buildTemplateFromPayload } from '../src/template.js';
import { TRIAL_CASES, buildTrialCase } from '../src/trial.js';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const enc = new TextEncoder();

function jsonFile(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value, null, 2) + '\n');
}

/** Payloads from the shared codec vectors, so the contract test also covers edge values. */
function codecPayloads(): { name: string; payload: Hex }[] {
  const path = join(PACKAGE_ROOT, '..', 'shared', 'vectors', 'codec.json');
  const v = JSON.parse(readFileSync(path, 'utf8')) as { claimToCourt: { name: string; encoded: Hex }[] };
  return v.claimToCourt.map((c) => ({ name: `codec: ${c.name}`, payload: c.encoded }));
}

export function fixtureFiles(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const goldenCases: { name: string; variant: number; payload: Hex; template: Hex }[] = [];

  for (const def of TRIAL_CASES) {
    const b = buildTrialCase(def, POLICY.uri);
    const dir = `fixtures/trial/${def.id}`;
    for (const d of b.docs) files.set(`${dir}/${d.key}.json`, d.bytes);
    files.set(`${dir}/precheck-result.json`, b.precheck.bytes);
    files.set(
      `${dir}/case.json`,
      jsonFile({
        id: def.id,
        variant: def.variant,
        purpose: def.purpose,
        expectRuling: def.expectRuling,
        orderId: b.orderId,
        claimId: b.claimId,
        payload: b.payload,
        policyURI: POLICY.uri,
        templateSha256: sha256(stringToHex(b.template)),
        records: b.docs.map((d) => ({ kind: d.kind, key: d.key, file: `${d.key}.json`, sha256: d.sha256, cid: d.cid })),
        precheck: {
          file: 'precheck-result.json',
          sha256: b.precheck.sha256,
          cid: b.precheck.cid,
          gap: b.precheck.result.gap,
          answer: b.precheck.result.answer,
          reasonKey: b.precheck.result.reasonKey,
        },
      }),
    );
    for (const v of TEMPLATE_VARIANTS) {
      goldenCases.push({
        name: `trial ${def.id}`,
        variant: v.id,
        payload: b.payload,
        template: stringToHex(buildTemplateFromPayload(b.payload, v.parts, POLICY.uri)),
      });
    }
  }

  for (const c of codecPayloads()) {
    for (const v of TEMPLATE_VARIANTS) {
      goldenCases.push({
        name: c.name,
        variant: v.id,
        payload: c.payload,
        template: stringToHex(buildTemplateFromPayload(c.payload, v.parts, POLICY.uri)),
      });
    }
  }

  files.set(
    'template/golden.json',
    jsonFile({
      policyURI: POLICY.uri,
      variants: TEMPLATE_VARIANTS.map((v) => ({ id: v.id, name: v.name, parts: v.parts.map((p) => stringToHex(p)) })),
      cases: goldenCases,
    }),
  );
  return files;
}

/** Paths whose bytes on disk differ from the generated ones. */
export function staleFixtures(): string[] {
  const stale: string[] = [];
  for (const [rel, bytes] of fixtureFiles()) {
    const path = join(PACKAGE_ROOT, rel);
    if (!existsSync(path) || Buffer.compare(readFileSync(path), Buffer.from(bytes)) !== 0) stale.push(rel);
  }
  return stale;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const stale = staleFixtures();
    if (stale.length > 0) {
      console.error(`stale fixtures:\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.log('fixtures up to date');
  } else {
    for (const [rel, bytes] of fixtureFiles()) {
      const path = join(PACKAGE_ROOT, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    console.log('fixtures written');
  }
}
