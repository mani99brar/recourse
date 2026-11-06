// Static server for the built web app (apps/web/dist), with no dependencies.
//   GET /health            {"ok":true}
//   /api/<path>            forwarded to the status API on 127.0.0.1:$STATUS_API_PORT as /<path>
//   any file under dist    served as is
//   any other path         index.html, so a refreshed or shared page link loads
// Env: WEB_PORT (default 8788), WEB_DIST_DIR (default ../../apps/web/dist), STATUS_API_PORT (default 8787),
// WEB_API_RATE_PER_S and WEB_API_BURST (the /api allowance per client, default 5 per second, bursts of 100).
// Binds 127.0.0.1 only; a reverse proxy faces the internet.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.WEB_PORT ?? 8788);
const apiPort = Number(process.env.STATUS_API_PORT ?? 8787);
const root = resolve(process.env.WEB_DIST_DIR ?? join(here, '../../apps/web/dist'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain',
};

function fileAt(urlPath) {
  let p;
  try { p = normalize(decodeURIComponent(urlPath)); } catch { return null; }
  const full = resolve(join(root, p));
  if (full !== root && !full.startsWith(root + sep)) return null;
  try { return statSync(full).isFile() ? full : null; } catch { return null; }
}

function send(res, full, status = 200) {
  const type = TYPES[extname(full)] ?? 'application/octet-stream';
  // Hashed asset files never change; the page itself is revalidated.
  const cache = full.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(status, { 'content-type': type, 'cache-control': cache });
  if (res.req.method === 'HEAD') { res.end(); return; }
  createReadStream(full).on('error', () => res.destroy()).pipe(res);
}

// A target such as `//` is scheme-relative to the WHATWG parser and throws against a base URL,
// so the path is appended to an absolute origin instead; anything still unparseable is a 400.
function parseTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('/')) return null;
  try { return new URL(`http://localhost${target}`); } catch { return null; }
}

// /api is public through the tunnel and some of its routes cost chain reads, so each client gets a
// token bucket. The client is CF-Connecting-IP, which Cloudflare sets on every request it forwards;
// a request that did not come through it (only local ones can reach this port) counts by its
// socket address. The defaults leave room for several people behind one address, each with a few
// pages polling every 5 s. Buckets idle long enough to refill are dropped, and the map is capped.
// A malformed value falls back to the default, so the limit is never silently off (NaN < 1 is false).
const numberOr = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const apiRate = Math.max(numberOr(process.env.WEB_API_RATE_PER_S, 5), 0.001);
const apiBurst = Math.max(numberOr(process.env.WEB_API_BURST, 100), 1);
const MAX_BUCKETS = 10_000;
const buckets = new Map();

function clientOf(req) {
  const cf = req.headers['cf-connecting-ip'];
  const v = (Array.isArray(cf) ? cf[0] : cf)?.trim();
  return (v || req.socket.remoteAddress || 'unknown').slice(0, 64);
}

function sweepBuckets(now) {
  const idle = (apiBurst / apiRate) * 1000;
  for (const [k, b] of buckets) if (now - b.at >= idle) buckets.delete(k);
}

/** Takes one token for the client; false when its bucket is empty. */
function takeToken(client, now = Date.now()) {
  let b = buckets.get(client);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) sweepBuckets(now);
    if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
    b = { tokens: apiBurst, at: now };
    buckets.set(client, b);
  }
  b.tokens = Math.min(apiBurst, b.tokens + ((now - b.at) / 1000) * apiRate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => sweepBuckets(Date.now()), 60_000).unref();

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
  }
});

function handle(req, res) {
  const url = parseTarget(req.url);
  if (!url) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad request'); return; }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const client = clientOf(req);
    // The v1 routes answer errors as {error: {code, message}}; the older read routes keep their shape.
    const v1 = url.pathname.startsWith('/api/v1/');
    const fail = (status, code, message, extra = {}) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(v1 ? { error: { code, message } } : { error: code === 'rate_limited' ? code : message }));
    };
    if (!takeToken(client)) {
      req.resume();
      fail(429, 'rate_limited', 'Too many requests from this client; try again shortly.', { 'retry-after': String(Math.ceil(1 / apiRate)) });
      return;
    }
    // The status API reads a POST body as JSON and limits actions per client, so the body's type and length
    // and the client this server counted are passed on; nothing else from the request is.
    const headers = { accept: req.headers.accept ?? '*/*', 'cf-connecting-ip': client };
    for (const h of ['content-type', 'content-length']) if (req.headers[h] !== undefined) headers[h] = req.headers[h];
    const up = http.request(
      { host: '127.0.0.1', port: apiPort, method: req.method, path: (url.pathname.slice(4) || '/') + url.search,
        headers, timeout: 15000 },
      (r) => {
        // Hop-by-hop headers describe the upstream connection, not this one: passing on its
        // `connection: keep-alive` overrode a client's `Connection: close`.
        const { connection: _c, 'keep-alive': _k, ...headers } = r.headers;
        res.writeHead(r.statusCode ?? 502, headers);
        r.pipe(res);
      },
    );
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => fail(502, 'upstream_unavailable', 'status API unreachable'));
    req.pipe(up);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const full = fileAt(url.pathname === '/' ? '/index.html' : url.pathname);
  if (full) return send(res, full);
  const index = fileAt('/index.html');
  if (index && extname(url.pathname) === '') return send(res, index);
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}
server.on('clientError', (_e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); else socket.destroy(); });
server.listen(port, '127.0.0.1', () => console.log(`web listening on 127.0.0.1:${port} serving ${root}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
