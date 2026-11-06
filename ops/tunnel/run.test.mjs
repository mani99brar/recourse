// node --test ops/tunnel/run.test.mjs
// run.sh (what recourse-tunnel-named.service runs) against a fake cloudflared in a temporary HOME: which
// command it execs with the token and with the credentials file, and what --check says when a file is
// missing. Nothing reaches Cloudflare; the token and the credentials are fixture text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runSh = join(dirname(fileURLToPath(import.meta.url)), 'run.sh');
const ID = '11111111-2222-3333-4444-555555555555';
const FIXTURE_TOKEN = ['fixture', 'tunnel', 'text'].join('-');

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'tunnel-run-'));
  const conf = join(home, '.config/recourse');
  mkdirSync(conf, { recursive: true });
  const cf = join(home, 'cf');
  const argv = join(home, 'argv');
  const env = join(home, 'env');
  writeFileSync(cf, ['#!/bin/bash', `echo "$*" > '${argv}'`, `env > '${env}'`].join('\n') + '\n');
  chmodSync(cf, 0o755);
  const yml = join(conf, 'cloudflared.yml');
  const token = join(conf, 'cloudflared.token');
  const cred = join(home, `.cloudflared/${ID}.json`);
  const run = (extraEnv = {}, ...args) =>
    spawnSync('bash', [runSh, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CLOUDFLARED: cf, ...extraEnv } });
  // What setup.sh writes for option 1 (ingress, a credentials file) and option 2 (no ingress).
  const option1 = () => {
    writeFileSync(yml, `tunnel: ${ID}\ncredentials-file: ${cred}\ningress:\n  - hostname: app.example.org\n    service: http://127.0.0.1:8788\n  - service: http_status:404\n`);
    mkdirSync(dirname(cred), { recursive: true });
    writeFileSync(cred, '{"fixture":true}\n', { mode: 0o600 });
  };
  const option2 = () => writeFileSync(yml, '# no ingress here\nno-autoupdate: true\n');
  const saveToken = () => writeFileSync(token, `${FIXTURE_TOKEN}\n`, { mode: 0o600 });
  const execed = () => (existsSync(argv) ? readFileSync(argv, 'utf8').trim() : null);
  const execEnv = () => readFileSync(env, 'utf8');
  return { home, conf, yml, token, cred, run, option1, option2, saveToken, execed, execEnv, done: () => rmSync(home, { recursive: true, force: true }) };
}

const quiet = (r) => !r.stdout.includes(FIXTURE_TOKEN) && !r.stderr.includes(FIXTURE_TOKEN);

test('with no files --check fails, names setup.sh, and nothing runs', () => {
  const s = sandbox();
  try {
    const r = s.run({}, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^recourse-tunnel-named: .*cloudflared\.yml is missing or empty: run ops\/tunnel\/setup\.sh first/);
    s.option2();
    const t = s.run({}, '--check');
    assert.equal(t.status, 1);
    assert.match(t.stderr, /cloudflared\.token is missing or empty: run ops\/tunnel\/setup\.sh first/);
    assert.match(t.stderr, /RECOURSE_TUNNEL_AUTH=credentials in .*tunnel\.env/);
    assert.equal(s.run().status, 1, 'ExecStart refuses too');
    assert.equal(s.execed(), null);
  } finally {
    s.done();
  }
});

test('by default it runs with the token file, and no token from the environment reaches cloudflared', () => {
  const s = sandbox();
  try {
    s.option2();
    s.saveToken();
    const c = s.run({}, '--check');
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /ready to run with the token/);
    assert.equal(s.execed(), null, '--check runs nothing');
    const r = s.run({ TUNNEL_TOKEN: 'env-fixture', TUNNEL_TOKEN_FILE: '/elsewhere', TUNNEL_CRED_CONTENTS: '{}' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.execed(), `tunnel --no-autoupdate --metrics 127.0.0.1:8790 --config ${s.yml} run --token-file ${s.token}`);
    assert.doesNotMatch(s.execEnv(), /^TUNNEL_(TOKEN|TOKEN_FILE|CRED_CONTENTS)=/m);
    assert.ok(quiet(r) && quiet(c));
  } finally {
    s.done();
  }
});

test('RECOURSE_TUNNEL_AUTH=credentials runs option 1 with the credentials file its config names, token or not', () => {
  const s = sandbox();
  try {
    s.option1();
    const auth = { RECOURSE_TUNNEL_AUTH: 'credentials' };
    const c = s.run(auth, '--check');
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /ready to run with the credentials/);
    s.saveToken();
    const r = s.run({ ...auth, TUNNEL_TOKEN_FILE: s.token });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.execed(), `tunnel --no-autoupdate --metrics 127.0.0.1:8790 --config ${s.yml} run`);
    assert.doesNotMatch(s.execEnv(), /^TUNNEL_TOKEN_FILE=/m, 'a token file in the environment would win over the credentials');
    assert.ok(quiet(r));
  } finally {
    s.done();
  }
});

test('credentials without a credentials file, or for a dashboard tunnel, fail clearly', () => {
  const s = sandbox();
  try {
    const auth = { RECOURSE_TUNNEL_AUTH: 'credentials' };
    s.option2();
    s.saveToken();
    const dash = s.run(auth, '--check');
    assert.equal(dash.status, 1);
    assert.match(dash.stderr, /names no credentials-file: a dashboard tunnel \(option 2\) runs only with its token/);
    s.option1();
    rmSync(s.cred);
    const gone = s.run(auth, '--check');
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, new RegExp(`the credentials file ${s.cred} that .* names is missing or empty`));
    writeFileSync(s.yml, `tunnel: <the id tunnel create prints>\ncredentials-file: ${s.cred}\n`);
    writeFileSync(s.cred, '{}\n');
    assert.match(s.run(auth, '--check').stderr, /names no tunnel id/);
    assert.equal(s.run(auth).status, 1);
    assert.equal(s.execed(), null);
  } finally {
    s.done();
  }
});

test('an unknown RECOURSE_TUNNEL_AUTH is refused without echoing what was set', () => {
  const s = sandbox();
  try {
    s.option1();
    s.saveToken();
    const r = s.run({ RECOURSE_TUNNEL_AUTH: FIXTURE_TOKEN }, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /RECOURSE_TUNNEL_AUTH in .*tunnel\.env is neither token nor credentials/);
    assert.ok(quiet(r));
    assert.equal(s.run({}, '--bogus').status, 1);
  } finally {
    s.done();
  }
});
