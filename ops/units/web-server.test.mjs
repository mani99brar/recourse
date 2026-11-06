// node --test ops/units/web-server.test.mjs
// Boots web-server.mjs on a free loopback port over a throwaway dist folder, with the status API
// port pointing at nothing, and checks that hostile targets get an answer and never stop the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let dir, child, port;

function boot(env) {
  const c = spawn(process.execPath, [join(here, 'web-server.mjs')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((ok, fail) => {
    c.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(c); });
    c.on('exit', (code) => fail(new Error(`server exited with ${code}`)));
  });
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
    s.on('error', fail);
  });
}

// Sends the request line exactly as given, so targets like `//` reach the server unchanged.
function raw(target, method = 'GET', headers = '', to = port, body = '') {
  return new Promise((ok, fail) => {
    const sock = net.connect(to, '127.0.0.1', () => sock.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\n${headers}Connection: close\r\n\r\n${body}`));
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
  // A small /api allowance that never refills during the test: five requests per client.
  child = await boot({ WEB_PORT: String(port), WEB_DIST_DIR: dir, STATUS_API_PORT: String(deadApi), WEB_API_RATE_PER_S: '0.001', WEB_API_BURST: '5' });
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

test('/api is limited per client: CF-Connecting-IP, else the socket address; pages and /health are not', async () => {
  const from = (ip) => `CF-Connecting-IP: ${ip}\r\n`;
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push((await raw('/api/parties/0x' + String(i).padStart(40, '0'), 'GET', from('198.51.100.7'))).status);
  assert.deepEqual(seen, [502, 502, 502, 502, 502, 429]);
  const limited = await raw('/api/claims', 'GET', from('198.51.100.7'));
  assert.equal(limited.status, 429);
  assert.match(limited.body, /rate_limited/);
  // Another client has its own allowance, and pages and /health are never limited.
  assert.equal((await raw('/api/claims', 'GET', from('198.51.100.8'))).status, 502);
  assert.equal((await raw('/', 'GET', from('198.51.100.7'))).status, 200);
  assert.equal((await raw('/health', 'GET', from('198.51.100.7'))).status, 200);
  assert.equal(child.exitCode, null);
});

test('a large request body to /api with the status API down is answered, not a crash', async () => {
  const body = 'x'.repeat(2 * 1024 * 1024);
  const r = await raw('/api/claims', 'POST', `CF-Connecting-IP: 203.0.113.9\r\nContent-Length: ${body.length}\r\n`, port, body).catch(() => ({ status: 0 }));
  assert.ok(r.status === 502 || r.status === 0, `answered ${r.status}`);
  assert.equal((await raw('/health')).status, 200);
  assert.equal(child.exitCode, null);
});

test('/api forwards the path without /api, keeps the query, and sends no client headers but accept', async () => {
  const seen = [];
  const api = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const apiPort = await new Promise((ok) => api.listen(0, '127.0.0.1', () => ok(api.address().port)));
  const webPort = await freePort();
  const web = await boot({ WEB_PORT: String(webPort), WEB_DIST_DIR: dir, STATUS_API_PORT: String(apiPort) });
  try {
    const r = await raw('/api/claims?party=0xabc', 'GET', 'Accept: application/json\r\nCookie: secret=1\r\nCF-Connecting-IP: 198.51.100.20\r\n', webPort);
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.equal(seen[0].url, '/claims?party=0xabc');
    assert.equal(seen[0].headers.accept, 'application/json');
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal((await raw('/api', 'GET', '', webPort)).status, 200);
    assert.equal(seen[1].url, '/');
  } finally {
    web.kill('SIGTERM');
    api.close();
  }
});
