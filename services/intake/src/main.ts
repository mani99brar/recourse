// recourse-intake service entry point. No signer, no key files, no chain calls.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Journal, createLogger, fetchDocument, ipfsOptionsFromEnv, pinDocument, pinProviderFromEnv, readJournal } from '@recourse/records';
import { createIntakeApp } from './app.js';
import { loadConfig } from './config.js';
import type { Fetcher, Pinner } from './intake.js';
import { Tagger } from './tagger.js';

const log = createLogger('intake');
try {
  const cfg = loadConfig();
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const now = () => Math.floor(Date.now() / 1000);

  let pinner: Pinner | undefined;
  let fetcher: Fetcher | undefined;
  try {
    const provider = pinProviderFromEnv();
    const opts = ipfsOptionsFromEnv();
    pinner = { pin: async (bytes) => (await pinDocument(bytes, provider, opts)).cid };
  } catch {
    log.warn('pin_off', { note: 'IPFS pinning is not configured; packCid will be null' });
  }
  try {
    const opts = ipfsOptionsFromEnv();
    fetcher = (cid, hash) => fetchDocument(cid, hash, opts);
  } catch {
    /* documents by CID are skipped without a gateway */
  }

  const path = join(cfg.stateDir, 'tags.jsonl');
  const counts: Record<string, number> = {};
  for (const r of readJournal<{ tag: string }>(path).rows) counts[r.tag] = (counts[r.tag] ?? 0) + 1;
  const journal = Journal.open<{ tag: string }>(path);

  const tagger = new Tagger({ apiKey: cfg.llmApiKey, model: cfg.llmModel, url: cfg.llmUrl, timeoutMs: cfg.llmTimeoutMs, pauseMin: cfg.llmPauseMin, now });
  const app = createIntakeApp({
    tagger, ...(pinner ? { pinner } : {}), ...(fetcher ? { fetcher } : {}), maxBytes: cfg.maxBytes, ratePerMin: cfg.ratePerMin, corsOrigin: cfg.corsOrigin, now,
    onTag: (tag) => {
      counts[tag] = (counts[tag] ?? 0) + 1;
      journal.append({ tag });
    },
    stats: () => ({ ...counts }),
  });
  app.listen(cfg.port, () => log.info('listening', { port: cfg.port, llm: tagger.status }));
} catch (error) {
  console.error(JSON.stringify({ service: 'intake', level: 'error', event: 'boot_failed', error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
