#!/usr/bin/env node
// Two runs side by side, as markdown: every row of results/<labelA>/results.json and results/<labelB>/,
// then the rows that passed in only one of them (the ones that pass on one deployment only).
//
//   node compare.mjs <labelA> <labelB>
//
// Rows are matched on suite, path and test with claim and order ids, statuses in parentheses and
// numbers (amounts, counts, times) taken out, so a check of "the claim" matches across deployments
// whose claims differ, and an ops row matches when its counts have moved on. A row
// with no partner is listed as only in A or only in B. Exit 1 when a row passed in only one run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './lib.mjs';

const [a, b] = process.argv.slice(2);
if (!a || !b) throw new Error('usage: compare.mjs <labelA> <labelB>');
const load = (l) => JSON.parse(readFileSync(join(HERE, 'results', l, 'results.json'), 'utf8'));
const A = load(a);
const B = load(b);

const STATUS = /\((filed|finding_made|no_finding|window_lapsed|closed_uncontested|contested|at_court|stuck|refused_once|ruled|zero_twice_answer_applied|unresolved|settled|expired|closed_undrawn)\)/g;
const norm = (s) =>
  String(s ?? '')
    .replace(/0x[0-9a-fA-F]{8,}/g, '{id}')
    .replace(STATUS, '({status})')
    .replace(/\d+(?:\.\d+)?/g, '{n}')
    .replace(/: (filed|finding_made|no_finding|window_lapsed|closed_uncontested|contested|settled)$/, ': {status}');

/** Rows keyed by their normalised name; the n-th row of a name gets #n. */
function keyed(run) {
  const seen = new Map();
  const out = new Map();
  for (const r of run.rows) {
    const base = `${r.suite} | ${norm(r.path)} | ${norm(r.test)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n > 1 ? `${base} #${n}` : base, r);
  }
  return out;
}
const ka = keyed(A);
const kb = keyed(B);
const keys = [...new Set([...ka.keys(), ...kb.keys()])];
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const res = (r) => (r ? `${r.result}${r.txHash ? ` ${r.txHash}` : ''}` : '-');
const named = (r) => `${r.suite} | ${r.path} | ${r.test}`;

const head = (run) => `${run.label}: commit ${run.commit ?? '?'}, ${run.started ?? '?'}; claims ${run.deployments?.claims ?? '?'}, vault ${run.deployments?.vault ?? '?'}, case ${run.deployments?.recourseCase ?? '?'}; pass ${run.counts.pass}, fail ${run.counts.fail}, blocked ${run.counts.blocked}, dry-only ${run.counts['dry-only']}`;
const lines = [`# ${a} and ${b} side by side`, '', `- A ${head(A)}`, `- B ${head(B)}`, '', `| Path | Test | A: ${cell(a)} | B: ${cell(b)} |`, '|---|---|---|---|'];
for (const k of keys) {
  const r = ka.get(k) ?? kb.get(k);
  lines.push(`| ${cell(r.path)} | ${cell(r.test)} | ${cell(res(ka.get(k)))} | ${cell(res(kb.get(k)))} |`);
}
const onlyOne = keys.filter((k) => ka.has(k) && kb.has(k) && (ka.get(k).result === 'pass') !== (kb.get(k).result === 'pass'));
const onlyA = keys.filter((k) => ka.has(k) && !kb.has(k));
const onlyB = keys.filter((k) => !ka.has(k) && kb.has(k));
const list = (title, ks, f) => [`## ${title} (${ks.length})`, '', ...(ks.length ? ks.map(f) : ['none']), ''];
lines.push(
  '',
  ...list('Passed in only one run', onlyOne, (k) => `- ${named(kb.get(k))}: A ${ka.get(k).result}, B ${kb.get(k).result}${(ka.get(k).result === 'pass' ? kb : ka).get(k).note ? ` (${(ka.get(k).result === 'pass' ? kb : ka).get(k).note})` : ''}`),
  ...list(`Only in A (${a})`, onlyA, (k) => `- ${named(ka.get(k))}: ${ka.get(k).result}`),
  ...list(`Only in B (${b})`, onlyB, (k) => `- ${named(kb.get(k))}: ${kb.get(k).result}`),
);
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(onlyOne.length ? 1 : 0);
