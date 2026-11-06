// Static server for the built web app (apps/web/dist), with no dependencies.
//   GET /health            {"ok":true}
//   /api/<path>            forwarded to the status API on 127.0.0.1:$STATUS_API_PORT as /<path>
//   any file under dist    served as is
//   any other path         index.html, so a refreshed or shared page link loads
// Env: WEB_PORT (default 8788), WEB_DIST_DIR (default ../../apps/web/dist), STATUS_API_PORT (default 8787).
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
    const up = http.request(
      { host: '127.0.0.1', port: apiPort, method: req.method, path: (url.pathname.slice(4) || '/') + url.search,
        headers: { accept: req.headers.accept ?? '*/*' }, timeout: 15000 },
      (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
    );
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"status API unreachable"}'); });
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
