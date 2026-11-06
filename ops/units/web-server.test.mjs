// node --test ops/units/web-server.test.mjs
// Boots web-server.mjs on a free loopback port over a throwaway dist folder, with the status API
// port pointing at nothing, and checks that hostile targets get an answer and never stop the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let dir, child, port;

function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
    s.on('error', fail);
  });
}

// Sends the request line exactly as given, so targets like `//` reach the server unchanged.
function raw(target, method = 'GET') {
  return new Promise((ok, fail) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let out = '';
    sock.on('data', (d) => { out += d; });
    sock.on('end', () => ok({ status: Number(out.split(' ')[1]), body: out.slice(out.indexOf('\r\n\r\n') + 4) }));
    sock.on('error', fail);
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'web-server-test-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>index</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  port = await freePort();
  const deadApi = await freePort();
  child = spawn(process.execPath, [join(here, 'web-server.mjs')], {
    env: { ...process.env, WEB_PORT: String(port), WEB_DIST_DIR: dir, STATUS_API_PORT: String(deadApi) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((ok, fail) => {
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); });
    child.on('exit', (code) => fail(new Error(`server exited with ${code}`)));
  });
});

after(() => {
  child?.kill('SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('hostile targets are answered and the server stays up', async () => {
  for (const t of ['//', '///', '//evil.example/x', '/%', '/%E0%A4%A', '/..%2f..%2fetc%2fpasswd', '/../../etc/passwd', '*']) {
    const r = await raw(t);
    assert.ok(r.status >= 200 && r.status < 500, `${t} answered ${r.status}`);
    assert.ok(!r.body.includes('root:'), `${t} leaked a file outside dist`);
  }
  assert.equal((await raw('/health')).status, 200);
  assert.equal(child.exitCode, null);
});

test('files, client routes, missing assets and HEAD', async () => {
  assert.match((await raw('/')).body, /<title>index/);
  assert.match((await raw('/case/0xabc')).body, /<title>index/);
  assert.match((await raw('/assets/app.js')).body, /console\.log\(1\)/);
  assert.equal((await raw('/assets/missing.js')).status, 404);
  const head = await raw('/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('an unreachable status API is a 502, not a crash', async () => {
  const r = await raw('/api/params');
  assert.equal(r.status, 502);
  assert.equal((await raw('/health')).status, 200);
});
