#!/usr/bin/env node
// Two runs side by side, as markdown: every row of results/<labelA>/results.json and results/<labelB>/,
// then the rows that passed in only one of them (the ones that pass on one deployment only).
//
//   node compare.mjs <labelA> <labelB>
//
// Rows are matched on suite, path and test with statuses in parentheses and numbers (amounts, counts,
// times) taken out, first keeping claim and order ids (the same claim in both runs), then with the ids
// taken out too, so a check of "the claim" matches across deployments whose claims differ, and an ops row
// matches when its counts have moved on. A row with no partner is listed as only in A or only in B; one
// that passed there is also a row that passed in only one run (it was not run, or not reached, in the other). Exit 1 when a row passed in only one run.

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

/** The same with claim and order ids kept: rows that name the same claim pair up first. */
const sameIds = (s) => {
  const ids = [];
  let i = 0;
  return norm(String(s ?? '').replace(/0x[0-9a-fA-F]{8,}/g, (m) => (ids.push(m), '\u0001'))).replace(/\u0001/g, () => ids[i++]);
};
const name = (f, r) => `${r.suite} | ${f(r.path)} | ${f(r.test)}`;

/**
 * Pairs of rows [a, b] (either missing): first a row of B naming the same ids as a row of A, then, for rows
 * left over (another deployment's claims), the n-th row of a normalised name in A with the n-th in B.
 */
function pairs() {
  const out = [];
  const leftB = new Set(B.rows);
  const byIds = new Map();
  for (const r of B.rows) byIds.set(name(sameIds, r), [...(byIds.get(name(sameIds, r)) ?? []), r]);
  const leftA = [];
  for (const r of A.rows) {
    const m = byIds.get(name(sameIds, r))?.find((x) => leftB.has(x));
    if (m) {
      leftB.delete(m);
      out.push([r, m]);
    } else leftA.push(r);
  }
  const byNorm = new Map();
  for (const r of B.rows.filter((x) => leftB.has(x))) byNorm.set(name(norm, r), [...(byNorm.get(name(norm, r)) ?? []), r]);
  for (const r of leftA) {
    const m = byNorm.get(name(norm, r))?.shift();
    if (m) leftB.delete(m);
    out.push([r, m]);
  }
  for (const r of B.rows.filter((x) => leftB.has(x))) out.push([undefined, r]);
  return out;
}
const all = pairs();
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const res = (r) => (r ? `${r.result}${r.txHash ? ` ${r.txHash}` : ''}` : '-');
const named = (r) => `${r.suite} | ${r.path} | ${r.test}`;

const head = (run) => `${run.label}: commit ${run.commit ?? '?'}, ${run.started ?? '?'}; claims ${run.deployments?.claims ?? '?'}, vault ${run.deployments?.vault ?? '?'}, case ${run.deployments?.recourseCase ?? '?'}; pass ${run.counts.pass}, fail ${run.counts.fail}, blocked ${run.counts.blocked}, dry-only ${run.counts['dry-only']}`;
const lines = [`# ${a} and ${b} side by side`, '', `- A ${head(A)}`, `- B ${head(B)}`, '', `| Path | Test | A: ${cell(a)} | B: ${cell(b)} |`, '|---|---|---|---|'];
for (const [ra, rb] of all) {
  const r = ra ?? rb;
  const test = ra && rb && ra.test !== rb.test ? `${ra.test} / B: ${rb.test}` : r.test;
  lines.push(`| ${cell(r.path)} | ${cell(test)} | ${cell(res(ra))} | ${cell(res(rb))} |`);
}
const passed = (r) => r?.result === 'pass';
const onlyOne = all.filter(([ra, rb]) => passed(ra) !== passed(rb));
const onlyA = all.filter(([ra, rb]) => ra && !rb);
const onlyB = all.filter(([ra, rb]) => !ra && rb);
const list = (title, ps, f) => [`## ${title} (${ps.length})`, '', ...(ps.length ? ps.map(f) : ['none']), ''];
lines.push(
  '',
  ...list('Passed in only one run', onlyOne, ([ra, rb]) => {
    const other = passed(ra) ? rb : ra;
    const both = ra && rb && ra.test !== rb.test ? ` / B: ${rb.test}` : '';
    return `- ${named(ra ?? rb)}${both}: A ${ra?.result ?? 'not in this run'}, B ${rb?.result ?? 'not in this run'}${other?.note ? ` (${other.note})` : ''}`;
  }),
  ...list(`Only in A (${a})`, onlyA, ([ra]) => `- ${named(ra)}: ${ra.result}`),
  ...list(`Only in B (${b})`, onlyB, ([, rb]) => `- ${named(rb)}: ${rb.result}`),
);
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(onlyOne.length ? 1 : 0);
