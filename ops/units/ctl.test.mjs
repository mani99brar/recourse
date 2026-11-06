// node --test ops/units/ctl.test.mjs
// ctl.sh health against fake curl, systemctl and ss on PATH: what it reads from each service's endpoints and
// how it prints it. Nothing on the host is asked; every body is fixture text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ctl = join(dirname(fileURLToPath(import.meta.url)), 'ctl.sh');
const KEYED = ['https://user:', 'pass@rpc.example.net/v1/', 'k'.repeat(8), '?apikey=zz9'].join('');

/** answers: { '<port><path>': [code, body] }; a URL not listed gets nothing (curl's 000). */
function sandbox(answers) {
  const dir = mkdtempSync(join(tmpdir(), 'ctl-health-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls');
  for (const [key, [code, body]] of Object.entries(answers)) {
    writeFileSync(join(dir, `${key.replace(/[^0-9a-z]/g, '_')}.body`), body);
    writeFileSync(join(dir, `${key.replace(/[^0-9a-z]/g, '_')}.code`), String(code));
  }
  const fake = (name, lines) => {
    writeFileSync(join(bin, name), ['#!/bin/bash', ...lines].join('\n') + '\n');
    chmodSync(join(bin, name), 0o755);
  };
  fake('curl', [
    'url=${@: -1}; w=0; for a in "$@"; do [ "$a" = -w ] && w=1; done',
    `echo "$url" >> '${calls}'`,
    `f='${dir}'/$(sed -e 's|^http://127.0.0.1:||' -e 's|[^0-9a-z]|_|g' <<<"$url")`,
    '[ -f "$f.body" ] || exit 7',
    'cat "$f.body"; [ "$w" = 0 ] || printf "\\n%s" "$(cat "$f.code")"',
  ]);
  fake('systemctl', ['printf "LoadState=loaded\\nActiveState=active\\nNRestarts=2\\nResult=success\\n"']);
  fake('ss', ['exit 0']);
  const run = (...args) => spawnSync('bash', [ctl, 'health', ...args], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir } });
  const urls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { run, urls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the docket's last poll error comes from GET /sources, redacted, in the table and in --json", () => {
  const s = sandbox({
    '8707/health': [200, JSON.stringify({ ok: true, failedWrites: 0 })],
    '8707/sources': [200, JSON.stringify({ sources: ['hedera-claims'], lastError: `fetch failed on ${KEYED}` })],
  });
  try {
    const j = s.run('--json', 'docket');
    assert.equal(j.status, 0, j.stderr);
    const [docket] = JSON.parse(j.stdout).services;
    assert.equal(docket.http, 200);
    assert.equal(docket.up, true);
    assert.deepEqual(docket.errors, ['sources.lastError: fetch failed on https://rpc.example.net/…']);
    const t = s.run('docket');
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^docket +active +2 +200 +up +sources\.lastError: fetch failed on https:\/\/rpc\.example\.net\/…$/m);
    for (const out of [j.stdout, t.stdout]) assert.ok(!out.includes('pass@') && !out.includes('zz9') && !out.includes('kkkkkkkk'));
  } finally {
    s.done();
  }
});

test('a docket with no /sources, or none set, adds no error; a docket that does not answer is not asked twice', () => {
  const quiet = sandbox({ '8707/health': [200, JSON.stringify({ failedWrites: 3 })], '8707/sources': [404, 'Cannot GET /sources'] });
  try {
    const [docket] = JSON.parse(quiet.run('--json', 'docket').stdout).services;
    assert.deepEqual(docket.errors, ['failedWrites: 3']);
  } finally {
    quiet.done();
  }
  const clean = sandbox({ '8707/health': [200, '{}'], '8707/sources': [200, JSON.stringify({ sources: [], lastError: null })] });
  try {
    assert.deepEqual(JSON.parse(clean.run('--json', 'docket').stdout).services[0].errors, []);
  } finally {
    clean.done();
  }
  const down = sandbox({});
  try {
    const [docket] = JSON.parse(down.run('--json', 'docket').stdout).services;
    assert.equal(docket.http, 0);
    assert.equal(docket.up, false);
    assert.deepEqual(down.urls(), ['http://127.0.0.1:8707/health']);
  } finally {
    down.done();
  }
});

test('other services are read at their health path only', () => {
  const s = sandbox({ '8706/health': [503, JSON.stringify({ problems: ['last tick 900 s ago'] })] });
  try {
    const [keeper] = JSON.parse(s.run('--json', 'keeper').stdout).services;
    assert.equal(keeper.up, false);
    assert.deepEqual(keeper.errors, ['problems: last tick 900 s ago']);
    assert.deepEqual(s.urls(), ['http://127.0.0.1:8706/health']);
  } finally {
    s.done();
  }
});
