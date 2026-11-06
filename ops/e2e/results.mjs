#!/usr/bin/env node
// Merges one run's JSON lines (results/<label>/raw/*.jsonl) into the one table the operator reads:
// results/<label>/results.json and results.md. The header gives the commit, the deployments the run
// tested (raw/deployments.json, written by run.sh at its start) and the run's times.
//
//   node results.mjs <label>
//
// Rows are taken in time order. Reads only the run's own files; exit 1 when a row failed.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, REPO, rowNote, testTable } from './lib.mjs';

const label = process.argv[2];
if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('usage: results.mjs <label>');
const dir = join(HERE, 'results', label);
const raw = join(dir, 'raw');
if (!existsSync(raw)) throw new Error(`no run ${label}: ${raw} does not exist`);

const json = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);
const meta = json(join(raw, 'meta.json'), {});
const deployments = json(join(raw, 'deployments.json'), null);

const rows = [];
for (const f of readdirSync(raw).filter((n) => n.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(raw, f), 'utf8').split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
}
rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

const git = (...a) => {
  try {
    return execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const commit = meta.commit ?? git('rev-parse', '--short', 'HEAD');
const count = (k) => rows.filter((r) => r.result === k).length;
const counts = { pass: count('pass'), fail: count('fail'), blocked: count('blocked'), 'dry-only': count('dry-only') };

const out = {
  label, commit, dirty: meta.dirty ?? null, started: meta.started ?? rows[0]?.t ?? null, finished: meta.finished ?? new Date().toISOString(), flags: meta.flags ?? null,
  deployments, counts,
  rows: rows.map((r) => ({ t: r.t, suite: r.suite, path: r.path, test: r.test, result: r.result, ...(r.code ? { code: r.code } : {}), ...(r.txHash ? { txHash: r.txHash } : {}), note: rowNote(r) })),
};
writeFileSync(join(dir, 'results.json'), `${JSON.stringify(out, null, 2)}\n`);

const d = deployments;
const header = [
  `# Test run ${label}`,
  '',
  `- Commit: ${commit ?? 'unknown'}${meta.dirty ? ' (with uncommitted changes)' : ''}`,
  `- Run: ${out.started ?? '?'} to ${out.finished}${meta.flags ? `, flags: ${meta.flags || 'none (dry)'}` : ''}`,
  d
    ? `- Deployments (${d.files.join(', ')}): Hedera ${d.chains.hedera} RecourseClaims ${d.claims}, DepositVault ${d.vault}, vault token ${d.vaultToken.label} ${d.usdc}; Arbitrum ${d.chains.arbitrum} RecourseCase ${d.recourseCase}; records topic ${d.topicFrom === 'HCS_RECORDS_TOPIC_ID' ? 'from HCS_RECORDS_TOPIC_ID' : d.recordsTopic}`
    : '- Deployments: not read (raw/deployments.json missing)',
  `- Results: pass ${counts.pass}, fail ${counts.fail}, blocked ${counts.blocked}, dry-only ${counts['dry-only']}`,
  '',
];
writeFileSync(join(dir, 'results.md'), `${header.join('\n')}${testTable(rows)}\n`);
console.log(`${header.join('\n')}\nresults: ${join(dir, 'results.md')}`);
process.exit(counts.fail ? 1 : 0);
