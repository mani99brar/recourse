// node --test ops/tunnel/setup.test.mjs
// setup.sh against a fake cloudflared in a temporary HOME: what it does with neither file, with a token file
// and with a cert, dry run and --apply. Nothing reaches Cloudflare; the "token" is fixture text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const setup = join(dirname(fileURLToPath(import.meta.url)), 'setup.sh');
const ID = '11111111-2222-3333-4444-555555555555';
const FIXTURE_TOKEN = ['fixture', 'tunnel', 'text'].join('-');

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'tunnel-setup-'));
  const conf = join(home, '.config/recourse');
  mkdirSync(conf, { recursive: true });
  const cf = join(home, 'cf');
  const calls = join(home, 'calls');
  writeFileSync(cf, [
    '#!/bin/bash',
    `echo "$*" >> '${calls}'`,
    'case "$2" in',
    `  list) [ -f '${home}/created' ] && echo '[{"id":"${ID}","name":"recourse"}]' || echo '[]' ;;`,
    `  create) touch '${home}/created' ;;`,
    '  route) ;;',
    `  token) echo ${FIXTURE_TOKEN} ;;`,
    'esac',
  ].join('\n') + '\n');
  chmodSync(cf, 0o755);
  const run = (...args) =>
    spawnSync('bash', [setup, '--web', 'app.example.org', '--shop', 'shop.example.org', ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, CLOUDFLARED: cf },
    });
  const callsMade = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { home, conf, run, callsMade, done: () => rmSync(home, { recursive: true, force: true }) };
}

test('with neither a cert nor a token it names both options and exits 2', () => {
  const s = sandbox();
  try {
    const r = s.run('--apply');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cloudflared tunnel login/);
    assert.match(r.stderr, /cloudflared\.token \(chmod 600\)/);
    assert.deepEqual(s.callsMade(), []);
  } finally {
    s.done();
  }
});

test('bad hostnames are refused', () => {
  const s = sandbox();
  try {
    const r = spawnSync('bash', [setup, '--web', 'App.Example.org', '--shop', 'shop.example.org'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: s.home } });
    assert.equal(r.status, 2);
  } finally {
    s.done();
  }
});

test('option 2: a token file of mode 600 needs nothing created; another mode is refused', () => {
  const s = sandbox();
  try {
    const token = join(s.conf, 'cloudflared.token');
    writeFileSync(token, `${FIXTURE_TOKEN}\n`);
    chmodSync(token, 0o644);
    assert.equal(s.run('--apply').status, 1);
    chmodSync(token, 0o600);
    const r = s.run('--apply');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.callsMade(), [], 'nothing is created on Cloudflare');
    const yml = readFileSync(join(s.conf, 'cloudflared.yml'), 'utf8');
    assert.doesNotMatch(yml, /^ingress:/m);
    assert.ok(!r.stdout.includes(FIXTURE_TOKEN));
  } finally {
    s.done();
  }
});

test('option 1: a dry run writes nothing; --apply creates, routes, writes the ingress and the token file', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.cloudflared'));
    writeFileSync(join(s.home, '.cloudflared/cert.pem'), 'fixture\n');
    const dry = s.run();
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would run: .* tunnel create recourse/);
    assert.ok(!existsSync(join(s.conf, 'cloudflared.yml')) && !existsSync(join(s.conf, 'cloudflared.token')));
    assert.deepEqual(s.callsMade().map((c) => c.split(' ')[1]), ['list'], 'a dry run only lists');

    const r = s.run('--apply');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(FIXTURE_TOKEN), 'the token is never printed');
    const calls = s.callsMade().slice(1);
    assert.deepEqual(calls, [
      'tunnel list --name recourse --output json',
      'tunnel create recourse',
      'tunnel list --name recourse --output json',
      'tunnel route dns recourse app.example.org',
      'tunnel route dns recourse shop.example.org',
      'tunnel token recourse',
    ]);
    const yml = readFileSync(join(s.conf, 'cloudflared.yml'), 'utf8');
    assert.match(yml, new RegExp(`^tunnel: ${ID}$`, 'm'));
    assert.match(yml, /- hostname: app\.example\.org\n {4}service: http:\/\/127\.0\.0\.1:8788\n/);
    assert.match(yml, /- hostname: shop\.example\.org\n {4}service: http:\/\/127\.0\.0\.1:8720\n/);
    assert.match(yml, /- service: http_status:404/);
    const token = join(s.conf, 'cloudflared.token');
    assert.equal(readFileSync(token, 'utf8').trim(), FIXTURE_TOKEN);
    assert.equal(statSync(token).mode & 0o777, 0o600);

    const again = s.run();
    assert.match(again.stdout, new RegExp(`tunnel recourse exists: ${ID}`));
    assert.doesNotMatch(again.stdout, /tunnel create/);
  } finally {
    s.done();
  }
});

// Fixture text standing in for a token the operator saved earlier (a dashboard tunnel's, or another run's).
const OTHER_TOKEN = ['dashboard', 'tunnel', 'text'].join('-');
const shows = (r, text) => r.stdout.includes(text) || r.stderr.includes(text);

test('option 1 never replaces an existing token without --force, and changes nothing on Cloudflare first', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.cloudflared'));
    writeFileSync(join(s.home, '.cloudflared/cert.pem'), 'fixture\n');
    const token = join(s.conf, 'cloudflared.token');
    writeFileSync(token, `${OTHER_TOKEN}\n`, { mode: 0o600 });

    const dry = s.run();
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /cloudflared\.token already exists; --apply stops here unless --force/);
    const listed = s.callsMade().length;

    const r = s.run('--apply');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists.*Nothing was changed/);
    assert.match(r.stderr, /move .*cert\.pem out of the way/);
    assert.match(r.stderr, /--force/);
    assert.equal(s.callsMade().length, listed, 'nothing is listed, created or routed before the refusal');
    assert.equal(readFileSync(token, 'utf8'), `${OTHER_TOKEN}\n`);
    assert.ok(!existsSync(`${token}.bak`) && !existsSync(join(s.conf, 'cloudflared.yml')));
    assert.ok(!shows(r, OTHER_TOKEN) && !shows(dry, OTHER_TOKEN), 'the token is never printed');
  } finally {
    s.done();
  }
});

test('option 1 with --force keeps the old token as .bak, mode 600, and a rerun with the same token keeps that .bak', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.cloudflared'));
    writeFileSync(join(s.home, '.cloudflared/cert.pem'), 'fixture\n');
    const token = join(s.conf, 'cloudflared.token');
    writeFileSync(token, `${OTHER_TOKEN}\n`);
    chmodSync(token, 0o644);

    const dry = s.run('--force');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would keep the current .*cloudflared\.token as .*cloudflared\.token\.bak \(mode 600\)/);
    assert.ok(!existsSync(`${token}.bak`));

    const r = s.run('--apply', '--force');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kept the old token as .*cloudflared\.token\.bak \(mode 600\)/);
    assert.equal(readFileSync(`${token}.bak`, 'utf8'), `${OTHER_TOKEN}\n`);
    assert.equal(statSync(`${token}.bak`).mode & 0o777, 0o600);
    assert.equal(readFileSync(token, 'utf8').trim(), FIXTURE_TOKEN);
    assert.equal(statSync(token).mode & 0o777, 0o600);
    assert.ok(!shows(r, OTHER_TOKEN) && !shows(r, FIXTURE_TOKEN), 'neither token is printed');

    const again = s.run('--apply', '--force');
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /holds this token already; left as it is/);
    assert.equal(readFileSync(`${token}.bak`, 'utf8'), `${OTHER_TOKEN}\n`, 'the same token again does not overwrite the .bak');
    assert.ok(!existsSync(`${token}.tmp`) && !existsSync(`${token}.bak.tmp`));
    assert.ok(!shows(again, FIXTURE_TOKEN));
  } finally {
    s.done();
  }
});
