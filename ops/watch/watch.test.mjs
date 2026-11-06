// node --test ops/watch/watch.test.mjs
// watch.sh against a fake journal (a folder of <unit>.log files), a fake health JSON and a fake notifier
// that appends "<title>\t<message>" to a file. No journal, unit or real notifier is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = join(dirname(fileURLToPath(import.meta.url)), 'watch.sh');
const CLAIM = `0x${'ab'.repeat(32)}`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'watch-test-'));
  const journal = join(dir, 'journal');
  mkdirSync(journal);
  const sent = join(dir, 'sent.tsv');
  const notifier = join(dir, 'notify');
  writeFileSync(notifier, `#!/bin/sh\nprintf '%s\\t%s\\n' "$1" "$2" >> '${sent}'\n`);
  chmodSync(notifier, 0o755);
  const health = join(dir, 'health.json');
  const t = {
    dir,
    keeper: join(journal, 'keeper.log'),
    precheck: join(journal, 'precheck.log'),
    setHealth(services) {
      writeFileSync(health, JSON.stringify({ at: '2026-11-06T12:00:00Z', services, strays: [] }));
    },
    run(extra = {}) {
      const r = spawnSync('bash', [watch], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, WATCH_STATE_DIR: join(dir, 'state'), WATCH_JOURNAL_DIR: journal,
          WATCH_HEALTH_FILE: health, RECOURSE_NOTIFY_CMD: notifier, ...extra },
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    },
    /** Messages the fake notifier got since the last call. */
    take() {
      if (!existsSync(sent)) return [];
      const rows = readFileSync(sent, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
      rmSync(sent);
      return rows;
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

test('the first run records where things are and sends nothing', () => {
  const t = setup();
  try {
    const out = t.run();
    assert.match(out, /first run/);
    assert.deepEqual(t.take(), []);
    assert.deepEqual(t.take(), []);
    t.run();
    assert.deepEqual(t.take(), [], 'a second run with nothing new sends nothing');
  } finally {
    t.done();
  }
});

test('a new alert line is forwarded once, without its stamp and prefix; other lines are not', () => {
  const t = setup();
  try {
    t.run();
    appendFileSync(t.keeper, [
      `2026-11-06T12:01:00.000Z claim ${CLAIM}: settle ok`,
      `2026-11-06T12:01:01.000Z alert settle_late ${CLAIM}: the ruling reached Hedera 900 s ago and settle has not landed`,
      '2026-11-06T12:01:02.000Z event hedera Settled',
    ].join('\n') + '\n');
    appendFileSync(t.precheck, 'alert mirror_lag: claim logs has been failing for over two minutes\n');
    t.run();
    assert.deepEqual(t.take(), [
      ['recourse keeper alert', 'settle_late <hex>: the ruling reached Hedera 900 s ago and settle has not landed'],
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
    t.run();
    const [[title, msg], [, long]] = t.take();
    assert.equal(title, 'recourse keeper alert');
    for (const bad of ['/v2/', 'apikey', 's3cr3tvalue', key, 'Ab12Cd34', jwt.slice(0, 20), 'AAHdqTcv']) {
      assert.ok(!msg.includes(bad), `sent text holds ${bad}: ${msg}`);
    }
    assert.match(msg, /https:\/\/rpc\.example\.org\//);
    assert.equal([...long].length, 600);
  } finally {
    t.done();
  }
});

test('a burst sends at most WATCH_MAX_SENDS alerts and counts the rest', () => {
  const t = setup();
  try {
    t.run();
    appendFileSync(t.keeper, Array.from({ length: 5 }, (_, i) => `2026-11-06T12:03:0${i}.000Z alert gas_low: ops-hedera ${i}`).join('\n') + '\n');
    t.run({ WATCH_MAX_SENDS: '3' });
    const got = t.take();
    assert.equal(got.length, 4);
    assert.equal(got[3][1], '2 more alert lines since the last check; see ctl.sh logs keeper');
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

test('with no usable notifier every message is logged and the run still succeeds', () => {
  for (const cmd of ['', '/nonexistent/notify']) {
    const t = setup();
    try {
      t.run({ RECOURSE_NOTIFY_CMD: cmd });
      appendFileSync(t.keeper, '2026-11-06T12:04:00.000Z alert fee_pool_low: the fee pool is below the floor\n');
      const out = t.run({ RECOURSE_NOTIFY_CMD: cmd });
      assert.match(out, /no usable notifier .*logged only: recourse keeper alert: fee_pool_low: the fee pool is below the floor/);
      assert.deepEqual(t.take(), []);
    } finally {
      t.done();
    }
  }
});

test('a notifier that fails is logged and the run still succeeds', () => {
  const t = setup();
  try {
    const failing = join(t.dir, 'fail');
    writeFileSync(failing, '#!/bin/sh\nexit 3\n');
    chmodSync(failing, 0o755);
    t.run({ RECOURSE_NOTIFY_CMD: failing });
    appendFileSync(t.keeper, '2026-11-06T12:05:00.000Z alert link_low: LINK below the floor\n');
    assert.match(t.run({ RECOURSE_NOTIFY_CMD: failing }), /the notifier failed; logged only/);
  } finally {
    t.done();
  }
});
