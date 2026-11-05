// Run in a separate Node process by the determinism test: prints every fixture's text hash.
import { render } from '../src/index.js';
import { FIXTURES } from './fixtures.js';

const out: Record<string, string> = {};
for (const [name, input] of Object.entries(FIXTURES)) out[name] = render(input).textHash;
process.stdout.write(JSON.stringify(out));
