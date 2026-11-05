import { describe, expect, it } from 'vitest';
import { PARAMS, handlingOf, readEnv, ENV_NAMES } from '../src/index.js';
import { vector } from './vectors.js';

describe('params', () => {
  it('params.json carries the same values as PARAMS', () => {
    const j = vector('params.json');
    expect(j.preLock).toEqual(PARAMS.preLock);
    expect(j.locked).toEqual(PARAMS.locked);
  });
  it('lock changes only the window, the exit delay and the timeout', () => {
    const changed = Object.keys(PARAMS.preLock).filter(
      (k) => PARAMS.preLock[k as keyof typeof PARAMS.preLock] !== PARAMS.locked[k as keyof typeof PARAMS.locked],
    );
    expect(changed.sort()).toEqual(['claimTimeout', 'contestWindow', 'exitDelay']);
    expect(PARAMS.locked.claimTimeout).toBeGreaterThan(PARAMS.locked.contestWindow);
  });
  it('handlingOf', () => {
    expect(handlingOf(120_000_000n, PARAMS.locked)).toBe(21_000_000n);
    expect(handlingOf(10_000_000_000n, PARAMS.locked)).toBe(40_000_000n);
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
});
