// The work of log-secret-scan.sh (see there). Reads the env files itself and compares their values here, in
// this process: a value is never put on a command line, in the environment of a child, in a file or in the
// output. Output: one line per (source, what) with the line numbers and a count, then totals.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';

const env = process.env;
const HOME = homedir();
const REPO = env.LOG_SCAN_REPO;
const CONFIG_DIR = env.LOG_SCAN_CONFIG_DIR || join(HOME, '.config/recourse');
const STATE_ROOT = env.LOG_SCAN_STATE_ROOT || join(HOME, '.local/state/recourse');
// Tests: LOG_SCAN_JOURNAL_DIR=<dir> reads <dir>/<unit>.log instead of journalctl.
const JOURNAL_DIR = env.LOG_SCAN_JOURNAL_DIR;
const MIN_LEN = 8;

// ---------------------------------------------------------------- values from the env files

/** NAME=value lines of one env file (systemd EnvironmentFile syntax: optional quotes, # comments). */
function parseEnvFile(path) {
  const out = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out.push({ name: m[1], value: v });
  }
  return out;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASS/;
const URL_NAME = /_URLS?(_|$)/;
const PATH_NAME = /(_FILE|_DIR)$/;
const keyLike = (s) => s.length >= 16 && /^[A-Za-z0-9_-]+$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s);

/** The parts of a URL value that would be a key: userinfo, query values, long mixed path segments. */
function urlKeyParts(value) {
  const parts = [];
  for (const one of value.split(/[,\s]+/).filter(Boolean)) {
    let u;
    try {
      u = new URL(one);
    } catch {
      continue;
    }
    if (u.password) parts.push(decodeURIComponent(u.password));
    if (u.username && keyLike(u.username)) parts.push(decodeURIComponent(u.username));
    for (const [, v] of u.searchParams) if (v.length >= MIN_LEN) parts.push(v);
    for (const seg of u.pathname.split('/')) if (keyLike(seg)) parts.push(seg);
  }
  return parts;
}

/** What to look for: [{ label, needles }], plus the names left out and why (names only). */
function secretValues() {
  const targets = [];
  const skipped = [];
  const files = existsSync(CONFIG_DIR) ? readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.env')).sort() : [];
  for (const f of files) {
    for (const { name, value } of parseEnvFile(join(CONFIG_DIR, f))) {
      const where = `${name} (${f})`;
      if (URL_NAME.test(name) && !SECRET_NAME.test(name)) {
        const parts = urlKeyParts(value);
        if (parts.length === 0) {
          skipped.push(`${where}: a URL with no key in it`);
          continue;
        }
        targets.push({ label: `value of ${name}`, needles: [value, ...parts].filter((n) => n.length >= MIN_LEN) });
      } else if (SECRET_NAME.test(name)) {
        if (value.length < MIN_LEN) {
          skipped.push(`${where}: shorter than ${MIN_LEN} characters, too short to search`);
          continue;
        }
        const path = PATH_NAME.test(name);
        targets.push({ label: path ? `value of ${name} (a path, not a secret)` : `value of ${name}`, needles: [value], path });
      }
    }
  }
  return { targets, skipped, files };
}

// ---------------------------------------------------------------- shapes

// What the services write next to the word "key" that is not a secret, taken out before the 64-hex test:
// an event's id ("key":"hedera:<tx hash>:<log index>", status API and keeper), a namespaced id such as
// local:<hash> (docket), and the reasonKey and entityKey fields (a pre-check reason, an Arkiv entity).
const BENIGN_NEAR_KEY = /\b(?:hedera|arbitrum|hcs|local):(?:0x)?[0-9a-f]{64}(?![0-9a-f])|\b(?:reasonKey|entityKey)\b/g;

const SHAPES = [
  ['64-hex next to "key" or "private"', /(?:key|private)[^\n]{0,24}?(?<![0-9a-f])(?:0x)?[0-9a-f]{64}(?![0-9a-f])|(?<![0-9a-f])(?:0x)?[0-9a-f]{64}(?![0-9a-f])[^\n]{0,24}?(?:key|private)/i],
  ['Hedera DER private key', /(?:302e020100300506032b657004220420|3030020100300706052b8104000a04220420|30740201010420)[0-9a-f]{64}/i],
  ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['keystore JSON', /"ciphertext"\s*:/],
  ['bot token', /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['API key (sk-, AKIA, ghp_, github_pat_, xox, AIza)', /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['RPC URL with a key in its path', /https?:\/\/[^\s"']*(?:alchemy\.com\/v2|infura\.io\/v3|quiknode\.pro|ankr\.com\/[a-z_]+)\/[A-Za-z0-9_-]{16,}/i],
  ['URL with a key in its query', /https?:\/\/[^\s"']+[?&](?:api[_-]?key|apikey|key|token|access[_-]?token|secret)=[^\s&"']{8,}/i],
  // An address (0x and 40 hex digits) after "token" is a token contract, not a secret.
  ['API key assigned', /(?:api[_-]?key|access[_-]?key|secret|token)["']?\s*[:=]\s*["']?(?!0x[0-9a-fA-F]{40}(?![0-9a-fA-F]))[A-Za-z0-9_-]{24,}/i],
];

// ---------------------------------------------------------------- sources

function filesUnder(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function stateFiles() {
  const out = [];
  if (existsSync(STATE_ROOT)) {
    for (const e of readdirSync(STATE_ROOT, { withFileTypes: true })) if (e.isDirectory()) out.push(...filesUnder(join(STATE_ROOT, e.name)));
  }
  if (REPO && existsSync(join(REPO, 'services'))) {
    for (const s of readdirSync(join(REPO, 'services'))) out.push(...filesUnder(join(REPO, 'services', s, 'state')));
  }
  return out.sort();
}

async function units() {
  if (JOURNAL_DIR) return readdirSync(JOURNAL_DIR).filter((f) => f.endsWith('.log')).map((f) => f.slice(0, -4)).sort();
  const names = new Set();
  const collect = (args) =>
    new Promise((resolve) => {
      const p = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      p.stdout.on('data', (d) => (buf += d));
      p.on('close', () => resolve(buf));
      p.on('error', () => resolve(''));
    });
  for (const l of (await collect(['journalctl', '--user', '--field=_SYSTEMD_USER_UNIT'])).split('\n')) {
    if (/^recourse-[A-Za-z0-9_.-]+$/.test(l.trim())) names.add(l.trim());
  }
  for (const l of (await collect(['systemctl', '--user', 'list-unit-files', 'recourse-*', '--no-legend'])).split('\n')) {
    const n = l.trim().split(/\s+/)[0];
    if (n && n.startsWith('recourse-')) names.add(n);
  }
  return [...names].sort();
}

function linesOf(source) {
  if (source.kind === 'file') return createInterface({ input: createReadStream(source.path), crlfDelay: Infinity });
  if (JOURNAL_DIR) return createInterface({ input: createReadStream(join(JOURNAL_DIR, `${source.unit}.log`)), crlfDelay: Infinity });
  const p = spawn('journalctl', ['--user', '-u', source.unit, '-o', 'cat', '--no-pager', '-q'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return createInterface({ input: p.stdout, crlfDelay: Infinity });
}

// ---------------------------------------------------------------- scan

const { targets, skipped, files: envFiles } = secretValues();
const hits = new Map(); // `${source}\t${label}` -> { lines: [], count }
const totals = new Map();
let scannedLines = 0;

function note(source, label, n) {
  const k = `${source}\t${label}`;
  const h = hits.get(k) ?? { lines: [], count: 0 };
  h.count += 1;
  if (h.lines.length < 10) h.lines.push(n);
  hits.set(k, h);
  totals.set(label, (totals.get(label) ?? 0) + 1);
}

async function scan(name, source) {
  let n = 0;
  for await (const line of linesOf(source)) {
    n += 1;
    for (const t of targets) if (t.needles.some((x) => line.includes(x))) note(name, t.label, n);
    for (const [label, re] of SHAPES) if (re.test(label === SHAPES[0][0] ? line.replace(BENIGN_NEAR_KEY, ' ') : line)) note(name, label, n);
  }
  scannedLines += n;
  return n;
}

const unitList = await units();
const fileList = stateFiles();
for (const u of unitList) await scan(`journal ${u}`, { kind: 'unit', unit: u });
let bytes = 0;
for (const f of fileList) {
  bytes += statSync(f).size;
  await scan(f.startsWith(HOME) ? `~/${relative(HOME, f)}` : f, { kind: 'file', path: f });
}

const pathLabels = new Set(targets.filter((t) => t.path).map((t) => t.label));
console.log(`log-secret-scan: env files ${envFiles.join(', ') || 'none'} in ${CONFIG_DIR.replace(HOME, '~')}: ${targets.filter((t) => !t.path).length} secret value(s) and ${pathLabels.size} key path(s) searched`);
for (const s of skipped) console.log(`  not searched: ${s}`);
console.log(`  read ${unitList.length} unit journal(s) and ${fileList.length} state file(s) (${Math.round(bytes / 1024)} KB), ${scannedLines} lines`);
let secrets = 0;
for (const [k, h] of [...hits.entries()].sort()) {
  const [source, label] = k.split('\t');
  const more = h.count > h.lines.length ? ',…' : '';
  console.log(`${source}\tline ${h.lines.join(',')}${more}\t${label}\tcount ${h.count}`);
  if (!pathLabels.has(label)) secrets += h.count;
}
for (const [label, c] of [...totals.entries()].sort()) console.log(`total\t${label}\t${c}`);
console.log(secrets === 0 ? 'log-secret-scan: no secret found' : `log-secret-scan: ${secrets} line hit(s) that may hold a secret`);
process.exitCode = secrets === 0 ? 0 : 1;
