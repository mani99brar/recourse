// node --test ops/units/units-env.test.mjs
// What each unit's environment can hold. Every unit but the web server reads the shared recourse.env, which
// holds keyed RPC URLs, API keys and the path of every role's keystore. A unit may keep only the key paths,
// secrets and keyed URLs its own code reads; the rest must be removed with UnsetEnvironment=, and the web
// server must not read the shared file at all.
//
// The first test works the unit files out on paper. The second runs each unit's environment lines in a
// throwaway transient unit (systemd-run --user) over a fixture env file with dummy values, so it checks what
// systemd on this host actually passes; it is skipped where systemd-run --user is not available.
// UNITS_DIR=<dir> points both at another copy of the unit files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const unitsDir = process.env.UNITS_DIR || here;
const SHARED = '%h/.config/recourse/recourse.env';

// Every env name the code knows (packages/shared/src/env.ts).
const envSrc = readFileSync(join(repo, 'packages/shared/src/env.ts'), 'utf8');
const ENV_NAMES = [...envSrc.slice(envSrc.indexOf('ENV_NAMES = ['), envSrc.indexOf('] as const')).matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);

// Names that open a key, carry a secret or carry a keyed URL. Nothing else in recourse.env is sensitive.
const KEY_FILES = ENV_NAMES.filter((n) => n.endsWith('_KEY_FILE'));
const SENSITIVE = [...KEY_FILES, 'KEYSTORE_DIR', 'ARKIV_ACCESS_KEY', 'LLM_API_KEY', 'IPFS_PIN_API_KEY', 'IPFS_PIN_API_SECRET',
  'ALERT_URL', 'HEDERA_RPC_URL_1', 'HEDERA_RPC_URL_2', 'ARB_RPC_URL', 'ARKIV_RPC_URL', 'SSH_AUTH_SOCK'];

// What each service needs, from its source and the package helpers it calls (pinning needs the Filebase
// pair; the shop's self-hosted facilitator pays fees from the facilitator key).
const NEEDS = {
  keeper: ['OPS_HEDERA_KEY_FILE', 'OPS_ARB_KEY_FILE', 'ALERT_URL', 'HEDERA_RPC_URL_1', 'HEDERA_RPC_URL_2', 'ARB_RPC_URL'],
  precheck: ['PRECHECK_SIGNER_KEY_FILE', 'ALERT_URL', 'HEDERA_RPC_URL_1', 'HEDERA_RPC_URL_2', 'IPFS_PIN_API_KEY', 'IPFS_PIN_API_SECRET'],
  shop: ['SHOP_KEY_FILE', 'FACILITATOR_KEY_FILE', 'HEDERA_RPC_URL_1'],
  'status-api': ['HEDERA_RPC_URL_1', 'HEDERA_RPC_URL_2', 'ARB_RPC_URL'],
  docket: ['SCHEME_KEY_FILE', 'ARKIV_ACCESS_KEY', 'ARKIV_RPC_URL', 'ALERT_URL', 'HEDERA_RPC_URL_1', 'ARB_RPC_URL', 'IPFS_PIN_API_KEY', 'IPFS_PIN_API_SECRET'],
  intake: ['LLM_API_KEY', 'IPFS_PIN_API_KEY', 'IPFS_PIN_API_SECRET'],
  web: [],
  'tunnel-web': [],
  'tunnel-shop': [],
};

function parseUnit(name) {
  const text = readFileSync(join(unitsDir, `recourse-${name}.service`), 'utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const values = (key) => lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));
  return {
    envFiles: values('EnvironmentFile').map((v) => v.replace(/^-/, '')),
    env: values('Environment'),
    unset: values('UnsetEnvironment').flatMap((v) => v.split(/\s+/).filter(Boolean)),
  };
}

/** The sensitive names a unit passes when recourse.env sets every known name (systemd applies Unset last). */
function passedOnPaper(unit, inherited) {
  const names = new Set(inherited);
  if (unit.envFiles.includes(SHARED)) for (const n of ENV_NAMES) names.add(n);
  for (const e of unit.env) names.add(e.split('=')[0]);
  for (const n of unit.unset) names.delete(n);
  return SENSITIVE.filter((n) => names.has(n)).sort();
}

const units = Object.keys(NEEDS).filter((n) => readdirSync(unitsDir).includes(`recourse-${n}.service`));

test('the unit files cover every service', () => {
  assert.deepEqual(units.sort(), Object.keys(NEEDS).sort());
});

test('on paper, each unit passes only the key paths, secrets and keyed URLs its service reads', () => {
  for (const name of units) {
    const got = passedOnPaper(parseUnit(name), ['SSH_AUTH_SOCK']);
    assert.deepEqual(got, [...NEEDS[name]].sort(), `recourse-${name}`);
  }
});

test('the web server reads no shared env file', () => {
  const web = parseUnit('web');
  assert.ok(!web.envFiles.includes(SHARED), 'recourse-web loads recourse.env');
  assert.ok(web.env.includes('STATUS_API_PORT=8787'), 'recourse-web must name the status API port itself');
});

test('every key path a service source names is one its unit keeps', () => {
  const svcDirs = { keeper: 'keeper', precheck: 'precheck', shop: 'shop', 'status-api': 'status-api', docket: 'docket', intake: 'intake' };
  for (const [name, dir] of Object.entries(svcDirs)) {
    const src = join(repo, 'services', dir, 'src');
    const out = spawnSync('grep', ['-rhoE', `'(${SENSITIVE.join('|')})'|env\\.(${SENSITIVE.join('|')})\\b`, src], { encoding: 'utf8' }).stdout;
    const named = [...new Set([...out.matchAll(/[A-Z][A-Z0-9_]+/g)].map((m) => m[0]))];
    for (const n of named) {
      // The shop's claim helpers sign as the platform too, but only the command-line scripts call them.
      if (name === 'shop' && n === 'PLATFORM_KEY_FILE') continue;
      assert.ok(NEEDS[name].includes(n), `services/${dir}/src reads ${n}, which recourse-${name} removes`);
    }
  }
});

function systemdRunWorks() {
  const r = spawnSync('systemd-run', ['--user', '--wait', '--pipe', '-q', '/bin/true'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0;
}

test('systemd on this host passes each unit only what its service reads', { skip: !systemdRunWorks() && 'no systemd-run --user here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'units-env-'));
  try {
    // Dummy values only: the real env files are never read here.
    const fixture = join(dir, 'recourse.env');
    writeFileSync(fixture, ENV_NAMES.map((n) => `${n}=/fixture/${n.toLowerCase()}`).join('\n') + '\n');
    for (const name of units) {
      const unit = parseUnit(name);
      const props = [];
      if (unit.envFiles.includes(SHARED)) props.push('-p', `EnvironmentFile=${fixture}`);
      for (const e of unit.env) props.push('-p', `Environment=${e}`);
      for (const u of unit.unset) props.push('-p', `UnsetEnvironment=${u}`);
      const r = spawnSync('systemd-run', ['--user', '--wait', '--pipe', '-q', ...props, '/usr/bin/env'], { encoding: 'utf8', timeout: 30000 });
      assert.equal(r.status, 0, `systemd-run for recourse-${name}: ${r.stderr}`);
      const present = new Set(r.stdout.split('\n').map((l) => l.split('=')[0]));
      const got = SENSITIVE.filter((n) => present.has(n)).sort();
      assert.deepEqual(got, [...NEEDS[name]].sort(), `recourse-${name} as systemd runs it`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Mount-namespace sandboxing needs a user namespace, which Ubuntu's AppArmor refuses to the user manager
// here (kernel.apparmor_restrict_unprivileged_userns=1): TemporaryFileSystem= and BindPaths= stop the unit
// with status 226/NAMESPACE, and the others are skipped without a word. Keep them out until that changes.
test('no unit relies on mount-namespace sandboxing this host cannot set up', () => {
  const NAMESPACED = /^(TemporaryFileSystem|BindPaths|BindReadOnlyPaths|InaccessiblePaths|ReadOnlyPaths|ReadWritePaths|ProtectHome|ProtectSystem|PrivateTmp|PrivateDevices|PrivateUsers|ProtectKernelTunables|ProtectKernelModules|ProtectControlGroups|ProtectProc)=/;
  for (const name of units) {
    const text = readFileSync(join(unitsDir, `recourse-${name}.service`), 'utf8');
    const hit = text.split('\n').find((l) => NAMESPACED.test(l.trim()));
    assert.equal(hit, undefined, `recourse-${name}: ${hit}`);
  }
});

// Restart and memory policy. Every long-running unit comes back on its own after a crash or an OOM kill
// (on-failure, a short RestartSec, no start limit), has a MemoryMax, and asks for OOMScoreAdjust=100.
// The caps together stay well under 2 GB on this 7.9 GB host, which runs other workloads beside these.
const LONG_RUNNING = Object.keys(NEEDS).filter((n) => n !== 'watch');
const sizeM = (v) => {
  const m = /^(\d+)([KMG])$/.exec(v);
  assert.ok(m, `MemoryMax=${v} is not a K/M/G size`);
  return Number(m[1]) * { K: 1 / 1024, M: 1, G: 1024 }[m[2]];
};

test('every long-running unit restarts on failure, has a memory cap and OOMScoreAdjust=100', () => {
  let total = 0;
  for (const name of LONG_RUNNING.filter((n) => units.includes(n))) {
    const text = readFileSync(join(unitsDir, `recourse-${name}.service`), 'utf8');
    const one = (key) => {
      const vals = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${key}=`));
      assert.equal(vals.length, 1, `recourse-${name}: ${key}= appears ${vals.length} times`);
      return vals[0].slice(key.length + 1);
    };
    assert.match(one('Restart'), /^(on-failure|always)$/, `recourse-${name}: Restart`);
    assert.ok(Number(one('RestartSec')) <= 10, `recourse-${name}: RestartSec`);
    assert.equal(one('StartLimitIntervalSec'), '0', `recourse-${name}: StartLimitIntervalSec`);
    assert.equal(one('OOMScoreAdjust'), '100', `recourse-${name}: OOMScoreAdjust`);
    total += sizeM(one('MemoryMax'));
  }
  assert.ok(total < 1536, `the MemoryMax caps add up to ${total}M`);
});

// A user unit cannot go below its manager's oom_score_adj (100 here): a lower value is raised to it
// without a warning, so a unit file asking for less would claim a protection it does not get.
test('systemd on this host gives a user unit the OOMScoreAdjust it asks for', { skip: !systemdRunWorks() && 'no systemd-run --user here' }, () => {
  const r = spawnSync('systemd-run', ['--user', '--wait', '--pipe', '-q', '-p', 'OOMScoreAdjust=100', '/bin/cat', '/proc/self/oom_score_adj'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '100');
});
