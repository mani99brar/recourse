// node --test ops/watch/watch.test.mjs
// watch.sh against a fake journalctl (first on PATH; it serves <dir>/journal/<unit>.log, one entry per line,
// the way `journalctl -o json` does, with -n, --after-cursor and a failing seek), a fake health JSON and a
// fake notifier that appends "<title>\t<message>" to a file. No journal, unit or real notifier is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = join(dirname(fileURLToPath(import.meta.url)), 'watch.sh');
const CLAIM = `0x${'ab'.repeat(30)}cdef`;

const FAKE_JOURNALCTL = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let unit, n, after;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-u') unit = args[++i];
  else if (args[i] === '-n') n = Number(args[++i]);
  else if (args[i].startsWith('--after-cursor=')) after = args[i].slice('--after-cursor='.length);
}
if (process.env.FAKE_JOURNALCTL_FAIL === '1') { console.error('Failed to open journal'); process.exit(1); }
const file = process.env.FAKE_JOURNAL + '/' + unit.replace(/^recourse-/, '') + '.log';
const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\\n') : [];
if (lines.at(-1) === '') lines.pop();
let rows = lines.map((m, i) => ({ __CURSOR: 's=fake;i=' + (i + 1), __REALTIME_TIMESTAMP: String(i), MESSAGE: m }));
if (after !== undefined) {
  const m = /^s=fake;i=(\\d+)$/.exec(after);
  if (!m) { console.error('Failed to seek to cursor: Invalid argument'); process.exit(1); }
  rows = rows.slice(Number(m[1]));
}
if (n !== undefined) rows = n === 0 ? [] : rows.slice(-n);
for (const r of rows) process.stdout.write(JSON.stringify(r) + '\\n');
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'watch-test-'));
  const journal = join(dir, 'journal');
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  mkdirSync(journal);
  mkdirSync(bin);
  writeFileSync(join(bin, 'journalctl'), FAKE_JOURNALCTL);
  chmodSync(join(bin, 'journalctl'), 0o755);
  const sent = join(dir, 'sent.tsv');
  const calls = join(dir, 'calls');
  /** A notifier that waits `sleep` seconds, then takes the message (exit 0) or refuses it (exit `exit`). */
  const notifier = (name, { sleep = 0, exit = 0 } = {}) => {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\necho x >> '${calls}'\n${sleep ? `sleep ${sleep}\n` : ''}${exit ? `exit ${exit}\n` : `printf '%s\\t%s\\n' "$1" "$2" >> '${sent}'\n`}`);
    chmodSync(f, 0o755);
    return f;
  };
  const health = join(dir, 'health.json');
  const t = {
    dir,
    state,
    keeper: join(journal, 'keeper.log'),
    precheck: join(journal, 'precheck.log'),
    ok: notifier('notify'),
    notifier,
    setHealth(services) {
      writeFileSync(health, JSON.stringify({ at: '2026-11-06T12:00:00Z', services, strays: [] }));
    },
    /** One watch run; `timeoutMs` stops it with SIGTERM the way systemd does (the notifier too). */
    spawn(extra = {}, timeoutMs) {
      const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, WATCH_STATE_DIR: state, FAKE_JOURNAL: journal,
        WATCH_HEALTH_FILE: health, RECOURSE_NOTIFY_CMD: t.ok, ...extra };
      const cmd = timeoutMs ? ['timeout', ['-s', 'TERM', String(timeoutMs / 1000), 'bash', watch]] : ['bash', [watch]];
      return spawnSync(cmd[0], cmd[1], { encoding: 'utf8', env });
    },
    run(extra = {}) {
      const r = t.spawn(extra);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      return r.stdout;
    },
    /** Messages the fake notifier took since the last call. */
    take() {
      if (!existsSync(sent)) return [];
      const rows = readFileSync(sent, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
      rmSync(sent);
      return rows;
    },
    /** How often a notifier was called since the last call. */
    calls() {
      if (!existsSync(calls)) return 0;
      const n = readFileSync(calls, 'utf8').split('\n').filter(Boolean).length;
      rmSync(calls);
      return n;
    },
    done() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  writeFileSync(t.keeper, '2026-11-06T10:00:00.000Z alert link_low: an old alert from before the watch\n');
  writeFileSync(t.precheck, '');
  t.setHealth([svc('keeper', true, 2), svc('shop', true, 0)]);
  return t;
}

function svc(service, up, restarts, extra = {}) {
  return { service, unit: up ? 'active' : 'activating', restarts, result: up ? 'success' : 'oom-kill', port: 1, path: '/health',
    http: up ? 200 : 0, up, ok: null, errors: [], ...extra };
}

const alerts = (n, from = 0) => Array.from({ length: n }, (_, i) => `2026-11-06T12:03:0${i}.000Z alert gas_low: ops-hedera ${from + i}`).join('\n') + '\n';

test('the first run records where things are and sends nothing', () => {
  const t = setup();
  try {
    const out = t.run();
    assert.match(out, /first run/);
    assert.deepEqual(t.take(), []);
    t.run();
    assert.deepEqual(t.take(), [], 'a second run with nothing new sends nothing');
  } finally {
    t.done();
  }
});

test('a journal that was empty when recorded is read from its start', () => {
  const t = setup();
  try {
    t.run();
    appendFileSync(t.precheck, 'alert mirror_lag: topic index has been failing for over two minutes\n');
    t.run();
    assert.deepEqual(t.take(), [['recourse precheck alert', 'mirror_lag: topic index has been failing for over two minutes']]);
  } finally {
    t.done();
  }
});

test('a new alert line is forwarded once, without its stamp and prefix, its claim id cut short; other lines are not', () => {
  const t = setup();
  try {
    t.run();
    appendFileSync(t.keeper, [
      `2026-11-06T12:01:00.000Z claim ${CLAIM}: settle ok`,
      `2026-11-06T12:01:01.000Z alert settle_late ${CLAIM}: the ruling reached Hedera 900 s ago and settle has not landed`,
      '2026-11-06T12:01:02.000Z event hedera Settled',
      `2026-11-06T12:01:03.000Z alert settle_failed ${CLAIM}: settle reverted in tx 0x${'9'.repeat(64)}`,
    ].join('\n') + '\n');
    appendFileSync(t.precheck, 'alert mirror_lag: claim logs has been failing for over two minutes\n');
    t.run();
    assert.deepEqual(t.take(), [
      ['recourse keeper alert', 'settle_late 0xabababab…cdef: the ruling reached Hedera 900 s ago and settle has not landed'],
      ['recourse keeper alert', 'settle_failed 0xabababab…cdef: settle reverted in tx <hex>'],
      ['recourse precheck alert', 'mirror_lag: claim logs has been failing for over two minutes'],
    ]);
    t.run();
    assert.deepEqual(t.take(), [], 'the same lines are not sent twice');
  } finally {
    t.done();
  }
});

test('no URL path or query, 64-hex string, JWT or long token is sent, and a message stops at 600 characters', () => {
  const t = setup();
  try {
    t.run();
    const key = 'f'.repeat(64);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl';
    appendFileSync(t.keeper, `2026-11-06T12:02:00.000Z alert rpc_down: params() failed: URL: https://rpc.example.org/v2/Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56?apikey=s3cr3tvalue key ${key} private 0x${key} auth ${jwt} bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq\n`);
    appendFileSync(t.keeper, `2026-11-06T12:02:01.000Z alert call_failed: ${'x'.repeat(900)}\n`);
    // Only the claim slot keeps a short form: a longer hex run there, or one in a kind that is not an
    // alerter kind, is replaced like any other.
    appendFileSync(t.keeper, `2026-11-06T12:02:02.000Z alert gas_low 0x${key}${key}: odd\n2026-11-06T12:02:03.000Z alert Bad1 0x${key}: odd\n`);
    t.run();
    const [[title, msg], [, long], [, longHex], [, badKind]] = t.take();
    assert.equal(title, 'recourse keeper alert');
    for (const bad of ['/v2/', 'apikey', 's3cr3tvalue', key, 'Ab12Cd34', jwt.slice(0, 20), 'AAHdqTcv']) {
      assert.ok(!msg.includes(bad), `sent text holds ${bad}: ${msg}`);
    }
    assert.match(msg, /https:\/\/rpc\.example\.org\//);
    assert.equal([...long].length, 600);
    assert.equal(longHex, 'gas_low <hex>: odd');
    assert.equal(badKind, 'Bad1 <hex>: odd');
  } finally {
    t.done();
  }
});

test('a burst sends at most WATCH_MAX_SENDS alerts and counts the rest', () => {
  const t = setup();
  try {
    t.run();
    appendFileSync(t.keeper, alerts(5));
    t.run({ WATCH_MAX_SENDS: '3' });
    const got = t.take();
    assert.equal(got.length, 4);
    assert.equal(got[3][1], '2 more alert lines since the last check; see ctl.sh logs keeper');
    t.run({ WATCH_MAX_SENDS: '3' });
    assert.deepEqual(t.take(), [], 'the counted lines are handled');
  } finally {
    t.done();
  }
});

test('a notifier that fails keeps the line and everything after it; the next run sends them once', () => {
  const t = setup();
  try {
    const failing = t.notifier('fail', { exit: 3 });
    t.run({ RECOURSE_NOTIFY_CMD: failing });
    appendFileSync(t.keeper, alerts(3));
    t.calls();
    const out = t.run({ RECOURSE_NOTIFY_CMD: failing });
    assert.match(out, /the notifier failed \(exit 3\); kept for the next run: recourse keeper alert: gas_low: ops-hedera 0/);
    assert.match(out, /recourse-keeper: 3 alert line\(s\) kept for the next run/);
    assert.doesNotMatch(out, /sent: /);
    assert.equal(t.calls(), 1, 'after one failure nothing else is tried this run');
    t.run();
    assert.deepEqual(t.take().map((r) => r[1]), ['gas_low: ops-hedera 0', 'gas_low: ops-hedera 1', 'gas_low: ops-hedera 2']);
    t.run();
    assert.deepEqual(t.take(), []);
  } finally {
    t.done();
  }
});

test('a send that does not finish in WATCH_SEND_TIMEOUT_S is kept for the next run', () => {
  const t = setup();
  try {
    t.run();
    appendFileSync(t.keeper, alerts(2));
    const out = t.run({ RECOURSE_NOTIFY_CMD: t.notifier('slow', { sleep: 5 }), WATCH_SEND_TIMEOUT_S: '1' });
    assert.match(out, /the notifier did not finish in 1\.000 s; kept for the next run/);
    assert.deepEqual(t.take(), []);
    t.run();
    assert.deepEqual(t.take().map((r) => r[1]), ['gas_low: ops-hedera 0', 'gas_low: ops-hedera 1']);
  } finally {
    t.done();
  }
});

test('a run out of time sends nothing more and the next run sends the rest', () => {
  const t = setup();
  try {
    t.run();
    appendFileSync(t.keeper, alerts(4));
    const out = t.run({ WATCH_BUDGET_S: '0' });
    assert.match(out, /4 message\(s\) kept for the next run: the run's 0 s for sending are used up/);
    assert.deepEqual(t.take(), []);
    t.run();
    assert.equal(t.take().length, 4);
  } finally {
    t.done();
  }
});

test('a run stopped part way through a burst loses nothing: the next run sends what the first did not', () => {
  const t = setup();
  try {
    t.run();
    appendFileSync(t.keeper, alerts(5));
    const r = t.spawn({ RECOURSE_NOTIFY_CMD: t.notifier('slow', { sleep: 1 }) }, 2500);
    assert.equal(r.status, 124, 'the run was stopped');
    const first = t.take().map((m) => m[1]);
    assert.ok(first.length < 5, `the stopped run sent ${first.length}`);
    t.run();
    const second = t.take().map((m) => m[1]);
    const all = [...first, ...second];
    for (let i = 0; i < 5; i++) assert.ok(all.includes(`gas_low: ops-hedera ${i}`), `alert ${i} never arrived: ${JSON.stringify(all)}`);
    assert.ok(all.length <= 6, `at most the one in flight comes twice: ${JSON.stringify(all)}`);
  } finally {
    t.done();
  }
});

test('a journal place journalctl cannot seek to starts again at the end, and says so', () => {
  const t = setup();
  try {
    t.run();
    writeFileSync(join(t.state, 'journal-keeper.cursor'), 'not a cursor\n');
    appendFileSync(t.keeper, alerts(1));
    const out = t.run();
    assert.match(out, /could not read from the saved place; started again at the journal's end/);
    assert.deepEqual(t.take(), [['recourse keeper alert', "the watch lost its place in the keeper journal and started again at its end; alerts written before now may not have been sent; see ctl.sh logs keeper"]]);
    appendFileSync(t.keeper, alerts(1, 7));
    t.run();
    assert.deepEqual(t.take(), [['recourse keeper alert', 'gas_low: ops-hedera 7']]);
  } finally {
    t.done();
  }
});

test('a journalctl that fails keeps the saved place', () => {
  const t = setup();
  try {
    t.run();
    appendFileSync(t.keeper, alerts(1));
    assert.match(t.run({ FAKE_JOURNALCTL_FAIL: '1' }), /recourse-keeper: journalctl failed; the saved place is kept/);
    t.run();
    assert.deepEqual(t.take(), [['recourse keeper alert', 'gas_low: ops-hedera 0']]);
  } finally {
    t.done();
  }
});

test('a service going down, staying down, coming back and restarting on its own', () => {
  const t = setup();
  try {
    t.run();
    t.setHealth([svc('keeper', false, 3, { errors: ['problems: last tick 300 s ago'] }), svc('shop', true, 0)]);
    t.run();
    assert.deepEqual(t.take(), [['recourse keeper down', 'keeper is down: unit activating, http 000, last result oom-kill; problems: last tick 300 s ago']]);
    t.run();
    assert.deepEqual(t.take(), [], 'still down: no second message');
    t.setHealth([svc('keeper', true, 3), svc('shop', true, 0)]);
    t.run();
    assert.deepEqual(t.take(), [['recourse keeper back', 'keeper is up again (unit active, http 200)']]);
    t.setHealth([svc('keeper', true, 3), svc('shop', true, 1)]);
    t.run();
    assert.deepEqual(t.take(), [['recourse shop restarted', 'shop restarted on its own 1 time(s) since the last check and is up (last result success)']]);
    t.setHealth([svc('keeper', true, 0), svc('shop', true, 1)]);
    t.run();
    assert.deepEqual(t.take(), [], 'a restart count that went down (a start by hand) is not news');
  } finally {
    t.done();
  }
});

test('a down message the notifier did not take is sent by the next run', () => {
  const t = setup();
  try {
    t.run();
    t.setHealth([svc('keeper', false, 3), svc('shop', true, 0)]);
    assert.match(t.run({ RECOURSE_NOTIFY_CMD: t.notifier('fail', { exit: 1 }) }), /kept for the next run: recourse keeper down/);
    t.run();
    assert.deepEqual(t.take(), [['recourse keeper down', 'keeper is down: unit activating, http 000, last result oom-kill']]);
    t.run();
    assert.deepEqual(t.take(), []);
  } finally {
    t.done();
  }
});

test('a service first seen down is recorded, not reported', () => {
  const t = setup();
  try {
    t.setHealth([svc('keeper', true, 0), svc('tunnel-named', false, 0, { unit: 'not-installed' })]);
    t.run();
    t.run();
    assert.deepEqual(t.take(), []);
  } finally {
    t.done();
  }
});

test('with no usable notifier every message is logged, counts as handled, and the run still succeeds', () => {
  for (const cmd of ['', '/nonexistent/notify']) {
    const t = setup();
    try {
      t.run({ RECOURSE_NOTIFY_CMD: cmd });
      appendFileSync(t.keeper, '2026-11-06T12:04:00.000Z alert fee_pool_low: the fee pool is below the floor\n');
      const out = t.run({ RECOURSE_NOTIFY_CMD: cmd });
      assert.match(out, /no usable notifier .*logged only: recourse keeper alert: fee_pool_low: the fee pool is below the floor/);
      assert.deepEqual(t.take(), []);
      t.run();
      assert.deepEqual(t.take(), [], 'a line logged only is not sent again once a notifier is set');
    } finally {
      t.done();
    }
  }
});
