import { execFileSync, spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bytesToHex, getAddress, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadKeyBytes, loadSigner, readParties } from '../src/node/index.js';

// Known-answer vectors from the Web3 Secret Storage definition (password "testpassword").
const SPEC_KEY = '0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d';
const SPEC_PBKDF2 = {
  crypto: {
    cipher: 'aes-128-ctr',
    cipherparams: { iv: '6087dab2f9fdbbfaddc31a909735c1e6' },
    ciphertext: '5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46',
    kdf: 'pbkdf2',
    kdfparams: {
      c: 262144,
      dklen: 32,
      prf: 'hmac-sha256',
      salt: 'ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd',
    },
    mac: '517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2',
  },
  id: '3198bc9c-6672-5ab3-d995-4942343ae5b6',
  version: 3,
};
/**
 * Writes a v3 scrypt keystore with the given cost. Used to cover a cost above Node's default
 * 32 MiB scrypt memory cap; encryption here is independent of the loader's decryption path.
 */
function scryptKeystore(key: string, password: string, n: number, r: number, p: number): object {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk = scryptSync(password, salt, 32, { N: n, r, p, maxmem: 512 * 1024 * 1024 });
  const cipher = createCipheriv('aes-128-ctr', dk.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(key.slice(2), 'hex')), cipher.final()]);
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ciphertext])).slice(2);
  return {
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: iv.toString('hex') },
      ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt',
      kdfparams: { dklen: 32, n, p, r, salt: salt.toString('hex') },
      mac,
    },
    id: '00000000-0000-4000-8000-000000000000',
    version: 3,
  };
}

let dir: string;
const logged: string[] = [];

function hasCast(): boolean {
  try {
    execFileSync('cast', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'recourse-keystore-test-'));
  writeFileSync(join(dir, 'pbkdf2.json'), JSON.stringify(SPEC_PBKDF2));
  writeFileSync(join(dir, 'pbkdf2.json.pass'), 'testpassword\n');
  writeFileSync(join(dir, 'scrypt.json'), JSON.stringify(scryptKeystore(SPEC_KEY, 'testpassword', 32768, 8, 1)));
  writeFileSync(join(dir, 'scrypt.json.pass'), 'testpassword');
  writeFileSync(join(dir, 'wrong.json'), JSON.stringify(SPEC_PBKDF2));
  writeFileSync(join(dir, 'wrong.json.pass'), 'not-the-password');
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  // Nothing in the loaders may write to the console, key material or otherwise.
  expect(logged).toEqual([]);
});

describe('loadKeyBytes / loadSigner', () => {
  it('decrypts the pbkdf2 known-answer keystore', () => {
    const env = { TEST_KEY_FILE: join(dir, 'pbkdf2.json') };
    const key = loadKeyBytes('TEST_KEY_FILE', env);
    expect(key.length).toBe(32);
    expect(bytesToHex(key)).toBe(SPEC_KEY);
    expect(loadSigner('TEST_KEY_FILE', env).address).toBe(privateKeyToAccount(SPEC_KEY).address);
  });

  it('decrypts a scrypt keystore whose cost exceeds the default memory cap', () => {
    const env = { TEST_KEY_FILE: join(dir, 'scrypt.json') };
    expect(bytesToHex(loadKeyBytes('TEST_KEY_FILE', env))).toBe(SPEC_KEY);
  });

  it.skipIf(!hasCast())('decrypts a keystore written by cast and agrees with its address', () => {
    const castDir = join(dir, 'cast');
    mkdirSync(castDir);
    const run = spawnSync('cast', ['wallet', 'new', castDir], {
      env: { ...process.env, CAST_PASSWORD: 'throwaway-test-only' },
      encoding: 'utf8',
    });
    const out = `${run.stdout}${run.stderr}`;
    const address = /Address:\s+(0x[0-9a-fA-F]{40})/.exec(out)?.[1];
    expect(address).toBeDefined();
    const file = join(castDir, readdirSync(castDir)[0]!);
    writeFileSync(`${file}.pass`, 'throwaway-test-only\n');
    const env = { TEST_KEY_FILE: file };
    const signer = loadSigner('TEST_KEY_FILE', env);
    expect(signer.address).toBe(address);
    const key = loadKeyBytes('TEST_KEY_FILE', env);
    expect(key.length).toBe(32);
    expect(privateKeyToAccount(bytesToHex(key)).address).toBe(signer.address);
  });

  it('fails on a wrong password naming only the env var', () => {
    const path = join(dir, 'wrong.json');
    let message = '';
    try {
      loadKeyBytes('TEST_KEY_FILE', { TEST_KEY_FILE: path });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^TEST_KEY_FILE: /);
    expect(message).not.toContain(path);
    expect(message).not.toContain('not-the-password');
    expect(message).not.toContain(SPEC_PBKDF2.crypto.ciphertext);
  });

  it('refuses a missing or relative path without echoing it', () => {
    expect(() => loadKeyBytes('TEST_KEY_FILE', {})).toThrow(/^TEST_KEY_FILE: not set$/);
    expect(() => loadKeyBytes('TEST_KEY_FILE', { TEST_KEY_FILE: 'keys/x.json' })).toThrow(
      /^TEST_KEY_FILE: must be an absolute path$/,
    );
    let message = '';
    try {
      loadKeyBytes('TEST_KEY_FILE', { TEST_KEY_FILE: join(dir, 'absent.json') });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('TEST_KEY_FILE: keystore file could not be read');
  });
});

describe('readParties', () => {
  it('reads and validates PARTIES_FILE', () => {
    const file = join(dir, 'parties.json');
    writeFileSync(
      file,
      JSON.stringify([
        {
          role: 'platform',
          evmAddress: '0x00000000000000000000000000000000000000a1',
          hederaAccountId: '0.0.1001',
          hcsWriters: ['0.0.1002'],
          agentId: 7,
          displayName: 'Example Platform',
        },
      ]),
    );
    const parties = readParties({ PARTIES_FILE: file });
    expect(parties[0]?.agentId).toBe('7');
    expect(parties[0]?.evmAddress).toBe(getAddress('0x00000000000000000000000000000000000000a1'));
  });

  it('refuses a relative path and a bad file', () => {
    expect(() => readParties({ PARTIES_FILE: 'deployments/parties.json' })).toThrow(/absolute/);
    const bad = join(dir, 'bad-parties.json');
    writeFileSync(bad, JSON.stringify([{ role: 'nobody' }]));
    expect(() => readParties({ PARTIES_FILE: bad })).toThrow(/^PARTIES_FILE: parties\[0\]\.role/);
  });
});
