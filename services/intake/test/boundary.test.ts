import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');

describe('intake boundary', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);

  it('imports no signer, node key loader, wallet client or Arkiv', () => {
    for (const [f, text] of files) {
      expect(text, f).not.toMatch(/@recourse\/shared\/node/);
      expect(text, f).not.toMatch(/@arkiv-network|createWalletClient|privateKeyToAccount|loadSigner|loadKeyBytes/);
    }
  });

  it('reads no key file variable or keystore directory', () => {
    for (const [f, text] of files) expect(text, f).not.toMatch(/_KEY_FILE|KEYSTORE_DIR|keystore/i);
  });

  it('reads only its own environment names', () => {
    const allowed = new Set(['INTAKE_PORT', 'INTAKE_CORS_ORIGIN', 'INTAKE_MAX_BYTES', 'INTAKE_RATE_PER_MIN', 'INTAKE_LLM_TIMEOUT_MS', 'INTAKE_LLM_PAUSE_MIN', 'INTAKE_STATE_DIR', 'LLM_API_KEY', 'LLM_MODEL', 'HOME', 'IPFS_PIN_API_KEY', 'IPFS_PIN_API_SECRET', 'IPFS_PIN_BUCKET', 'IPFS_GATEWAY_URL', 'IPFS_PIN_API_URL']);
    for (const [f, text] of files) {
      for (const m of text.matchAll(/env(?:\.|\[['"])([A-Z][A-Z0-9_]+)/g)) expect(allowed.has(m[1]!), `${f}: ${m[1]}`).toBe(true);
    }
  });

  it('calls no contract', () => {
    for (const [f, text] of files) expect(text, f).not.toMatch(/readContract|writeContract|eth_call|sendTransaction/);
  });
});
