import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PARAMS,
  handlingOf,
  readEnv,
  ENV_NAMES,
  VITE_ENV_NAMES,
  isSendPaused,
  parseSendPauseWindows,
} from '../src/index.js';
import { vector } from './vectors.js';

describe('params', () => {
  it('params.json carries the same values as PARAMS', () => {
    const j = vector('params.json');
    expect(j.preLock).toEqual(PARAMS.preLock);
    expect(j.locked).toEqual(PARAMS.locked);
  });
  it('lock changes only the contest window and the exit delay', () => {
    const changed = Object.keys(PARAMS.preLock).filter(
      (k) => PARAMS.preLock[k as keyof typeof PARAMS.preLock] !== PARAMS.locked[k as keyof typeof PARAMS.locked],
    );
    expect(changed.sort()).toEqual(['contestWindow', 'exitDelay']);
    expect(PARAMS.preLock.claimTimeout).toBe(64_800);
    expect(PARAMS.locked.claimTimeout).toBe(PARAMS.preLock.claimTimeout);
    expect(PARAMS.locked.claimTimeout).toBeGreaterThan(PARAMS.locked.contestWindow);
  });
  it('handlingOf', () => {
    expect(handlingOf(2_500_000n, PARAMS.locked)).toBe(1_125_000n);
    expect(handlingOf(3_000_000n, PARAMS.locked)).toBe(1_150_000n);
    expect(handlingOf(60_000_000n, PARAMS.locked)).toBe(4_000_000n);
    expect(handlingOf(10_000_000_000n, PARAMS.locked)).toBe(4_000_000n);
  });
  it('the demo amounts fit a 20 USDC faucet: 18 USDC covers four uncontested platform-fault payouts on 3 USDC baskets', () => {
    const p = PARAMS.locked;
    const worstUncontested = 3_000_000n + handlingOf(3_000_000n, p);
    expect(worstUncontested).toBe(4_150_000n);
    expect(4n * worstUncontested).toBeLessThanOrEqual(18_000_000n);
    expect(BigInt(p.courtFeeUsdc)).toBe(1_000_000n);
    expect(BigInt(p.minDeposit)).toBeLessThanOrEqual(18_000_000n);
  });
});

describe('readEnv', () => {
  it('reads set names and defaults, and names every missing one without values', () => {
    const env = { HEDERA_RPC_URL_1: 'https://example.test/rpc', ARB_RPC_URL: '' };
    expect(readEnv(['HEDERA_RPC_URL_1', 'HEDERA_MIRROR_URL'], { env })).toEqual({
      HEDERA_RPC_URL_1: 'https://example.test/rpc',
      HEDERA_MIRROR_URL: 'https://testnet.mirrornode.hedera.com',
    });
    expect(readEnv(['SHOP_PORT'], { env, defaults: { SHOP_PORT: '8571' } })).toEqual({ SHOP_PORT: '8571' });
    expect(() => readEnv(['ARB_RPC_URL', 'LLM_API_KEY', 'HEDERA_RPC_URL_1'], { env })).toThrow(
      /^readEnv: missing ARB_RPC_URL, LLM_API_KEY$/,
    );
    expect(() => readEnv(['VITE_POLL_MS' as never], { env })).toThrow(/not a known env name/);
  });
  it('lists every name once', () => {
    expect(new Set(ENV_NAMES).size).toBe(ENV_NAMES.length);
  });
  it('.env.example lists exactly the env names and the VITE names, with no values', () => {
    const text = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(lines.every((l) => /^[A-Z0-9_]+=$/.test(l))).toBe(true);
    expect(lines.map((l) => l.slice(0, -1)).sort()).toEqual([...ENV_NAMES, ...VITE_ENV_NAMES].sort());
  });
  it('the precheck quiet time, the pause windows and the court link are optional', () => {
    expect(readEnv(['PRECHECK_QUIET_S', 'SEND_PAUSE_WINDOWS', 'COURT_URL_TEMPLATE'], { env: {} })).toEqual({
      PRECHECK_QUIET_S: '120',
      SEND_PAUSE_WINDOWS: '',
      COURT_URL_TEMPLATE: 'https://v2-testnet.kleros.builders/#/cases/{id}/overview',
    });
  });
});

describe('send pause windows', () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  it('parses a comma list and checks [from, to) per chain', () => {
    const w = parseSendPauseWindows(
      'hedera@2026-11-06T17:45:00Z/2026-11-06T18:55:00Z, arbitrum@2026-11-07T00:00:00Z/2026-11-07T00:30:00.5Z',
    );
    expect(w).toEqual([
      { chain: 'hedera', from: at('2026-11-06T17:45:00Z'), to: at('2026-11-06T18:55:00Z') },
      { chain: 'arbitrum', from: at('2026-11-07T00:00:00Z'), to: at('2026-11-07T00:30:00Z') },
    ]);
    expect(isSendPaused(w, 'hedera', at('2026-11-06T17:44:59Z'))).toBe(false);
    expect(isSendPaused(w, 'hedera', at('2026-11-06T17:45:00Z'))).toBe(true);
    expect(isSendPaused(w, 'hedera', BigInt(at('2026-11-06T18:54:59Z')))).toBe(true);
    expect(isSendPaused(w, 'hedera', at('2026-11-06T18:55:00Z'))).toBe(false);
    expect(isSendPaused(w, 'arbitrum', at('2026-11-06T18:00:00Z'))).toBe(false);
    expect(parseSendPauseWindows('')).toEqual([]);
    expect(parseSendPauseWindows('  ')).toEqual([]);
  });
  it.each([
    'hedera@2026-11-06T17:45:00Z',
    'base@2026-11-06T17:45:00Z/2026-11-06T18:55:00Z',
    'hedera@2026-11-06T17:45:00/2026-11-06T18:55:00Z',
    'hedera@2026-11-06T17:45:00+01:00/2026-11-06T18:55:00Z',
    'hedera@2026-02-30T17:45:00Z/2026-03-06T18:55:00Z',
    'hedera@2026-11-06T18:55:00Z/2026-11-06T18:55:00Z',
    'hedera@2026-11-06T17:45:00Z/2026-11-06T18:55:00Z,',
  ])('rejects %s', (text) => {
    expect(() => parseSendPauseWindows(text)).toThrow(/^SEND_PAUSE_WINDOWS: /);
  });
});
