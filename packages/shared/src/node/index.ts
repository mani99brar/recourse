// Node-only entry: `@recourse/shared/node`. The browser barrel never imports this file.

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseParties, type Parties } from '../parties.js';

export { loadKeyBytes, loadSigner } from './keystore.js';

type Env = Record<string, string | undefined>;

/** Reads and validates the party map at PARTIES_FILE (an absolute path). */
export function readParties(env: Env = process.env): Parties {
  const path = env.PARTIES_FILE;
  if (path === undefined || path === '') throw new Error('PARTIES_FILE: not set');
  if (!isAbsolute(path)) throw new Error('PARTIES_FILE: must be an absolute path');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error('PARTIES_FILE: could not be read');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('PARTIES_FILE: not valid JSON');
  }
  const result = parseParties(json);
  if (!result.ok) throw new Error(`PARTIES_FILE: ${result.error}`);
  return result.value;
}
