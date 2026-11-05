// Fails when a secret env name or a password-file name appears in the web source or its build.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = ['ARKIV_ACCESS_KEY', 'LLM_API_KEY', 'IPFS_PIN_API_KEY', 'IPFS_PIN_API_SECRET', 'IPFS_PIN_API_URL'];
const PATTERNS = [/[A-Z][A-Z0-9_]*_KEY(_FILE)?\b/, /[A-Z][A-Z0-9_]*_SECRET\b/, /\.pass\b/];
const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.vite') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs|css|html|json|map)$/.test(name)) {
      const text = readFileSync(p, 'utf8');
      for (const n of NAMES) if (text.includes(n)) hits.push(`${p}: ${n}`);
      for (const re of PATTERNS) {
        const m = re.exec(text);
        if (m) hits.push(`${p}: ${m[0]}`);
      }
    }
  }
}

for (const dir of ['src', 'dist', 'index.html']) {
  const p = join(root, dir);
  if (!existsSync(p)) continue;
  if (statSync(p).isDirectory()) walk(p);
  else {
    const text = readFileSync(p, 'utf8');
    for (const n of NAMES) if (text.includes(n)) hits.push(`${p}: ${n}`);
  }
}
if (hits.length) {
  console.error('secret-looking names found:\n' + hits.join('\n'));
  process.exit(1);
}
console.log('check:secrets clean');
