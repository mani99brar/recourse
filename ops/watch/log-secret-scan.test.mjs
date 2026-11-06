// node --test ops/watch/log-secret-scan.test.mjs
// log-secret-scan.mjs over a fixture config folder, journal folder and state folder: it finds each planted
// value and shape at the right line, and its output never holds a planted value. Fixture values are built
// at run time; none is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'log-secret-scan.mjs');
const mixed = (seed, n) => Array.from({ length: n }, (_, i) => 'aB3xY9kQ7mN2pR5t'[(i * 7 + seed) % 16]).join('');

test('finds planted values and shapes, reports lines and counts, and prints no value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-scan-test-'));
  try {
    const cfg = join(dir, 'config');
    const journal = join(dir, 'journal');
    const state = join(dir, 'state');
    const repo = join(dir, 'repo');
    for (const d of [cfg, journal, join(state, 'keeper'), join(repo, 'services/shop/state')]) mkdirSync(d, { recursive: true });

    const rpcKey = mixed(1, 32);
    const apiKey = mixed(2, 40);
    const rpcUrl = `https://rpc.fixture.test/v2/${rpcKey}`;
    const env = [
      `ARB_RPC_URL=${rpcUrl}`,
      'HEDERA_RPC_URL_1=https://testnet.fixture.test/api',
      `LLM_API_` + `KEY="${apiKey}"`,
      'OPS_HEDERA_KEY_FILE=/fixture/keys/ops-hedera.json',
      'SHORT_TOKEN=abc',
      'KEEPER_PORT=8706',
    ];
    writeFileSync(join(cfg, 'recourse.env'), env.join('\n') + '\n');

    const hex = 'c'.repeat(64);
    writeFileSync(join(journal, 'recourse-keeper.service.log'), [
      'started',
      `params() failed: URL: ${rpcUrl} Request body: {}`,
      `claim 0x${hex}: settle ok`,
      `signer private 0x${hex}`,
      'reading /fixture/keys/ops-hedera.json',
      `{"key":"hedera:0x${hex}:3","reasonKey":"no_gap"}`,
      `operator key:0x${hex}`,
    ].join('\n') + '\n');
    writeFileSync(join(journal, 'recourse-intake.service.log'), `tagger: key ${apiKey.slice(0, 4)}… only a prefix\nnothing here\n`);
    writeFileSync(join(state, 'keeper', 'journal.jsonl'), `{"t":"x"}\n{"auth":"Bearer ${mixed(3, 30)}"}\n`);
    writeFileSync(join(repo, 'services/shop/state', 'records.jsonl'), `{"llm":"${apiKey}"}\n`);

    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, LOG_SCAN_CONFIG_DIR: cfg, LOG_SCAN_JOURNAL_DIR: journal, LOG_SCAN_STATE_ROOT: state, LOG_SCAN_REPO: repo },
    });
    const out = r.stdout;
    assert.equal(r.status, 1, out + r.stderr);
    for (const v of [rpcKey, apiKey, hex, mixed(3, 30), 'fixture.test/v2']) assert.ok(!out.includes(v), `the output holds a planted value: ${out}`);

    const row = (source, label) => out.split('\n').find((l) => l.startsWith(`${source}\t`) && l.includes(`\t${label}\t`));
    assert.match(row('journal recourse-keeper.service', 'value of ARB_RPC_URL') ?? '', /\tline 2\t.*\tcount 1$/);
    assert.match(row('journal recourse-keeper.service', '64-hex next to "key" or "private"') ?? '', /\tline 4,7\t.*\tcount 2$/);
    assert.match(row('journal recourse-keeper.service', 'value of OPS_HEDERA_KEY_FILE (a path, not a secret)') ?? '', /\tline 5\t/);
    assert.match(row('~/state/keeper/journal.jsonl', 'bearer token') ?? '', /\tline 2\t/);
    assert.match(row('~/repo/services/shop/state/records.jsonl', 'value of LLM_API_KEY') ?? '', /\tline 1\t.*\tcount 1$/);
    assert.equal(row('journal recourse-intake.service', 'value of LLM_API_KEY'), undefined, 'a prefix is not the value');
    assert.match(out, /not searched: HEDERA_RPC_URL_1 \(recourse\.env\): a URL with no key in it/);
    assert.match(out, /not searched: SHORT_TOKEN \(recourse\.env\): shorter than 8 characters/);
    assert.match(out, /^total\tvalue of ARB_RPC_URL\t1$/m);
    assert.match(out, /log-secret-scan: 5 line hit\(s\) that may hold a secret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clean set of sources exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-scan-test-'));
  try {
    mkdirSync(join(dir, 'config'));
    mkdirSync(join(dir, 'journal'));
    writeFileSync(join(dir, 'config', 'recourse.env'), `ARB_RPC_URL=https://rpc.fixture.test/v2/${mixed(4, 32)}\n`);
    writeFileSync(join(dir, 'journal', 'recourse-web.service.log'), 'listening on 127.0.0.1:8788\n');
    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, LOG_SCAN_CONFIG_DIR: join(dir, 'config'), LOG_SCAN_JOURNAL_DIR: join(dir, 'journal'), LOG_SCAN_STATE_ROOT: join(dir, 'none') },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no secret found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
