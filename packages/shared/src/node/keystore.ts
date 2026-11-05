// Foundry (Web3 Secret Storage v3) keystore loading. Node only.
//
// The keystore path comes from an env var; the password from the file next to it, `<path>.pass`.
// Errors name the env var and what went wrong, never the path, the password or any file content.

import { createDecipheriv, pbkdf2Sync, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { bytesToHex, keccak256 } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

type Env = Record<string, string | undefined>;

class KeystoreError extends Error {
  constructor(envName: string, problem: string) {
    super(`${envName}: ${problem}`);
    this.name = 'KeystoreError';
  }
}

function hexBytes(value: unknown, envName: string, field: string): Buffer {
  if (typeof value !== 'string') throw new KeystoreError(envName, `keystore field ${field} missing`);
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new KeystoreError(envName, `keystore field ${field} is not hex`);
  }
  return Buffer.from(hex, 'hex');
}

function positiveInt(value: unknown, envName: string, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new KeystoreError(envName, `keystore field ${field} is not a positive integer`);
  }
  return value;
}

function deriveKey(crypto: Record<string, unknown>, password: Buffer, envName: string): Buffer {
  const kdf = crypto.kdf;
  const params = crypto.kdfparams;
  if (typeof params !== 'object' || params === null) throw new KeystoreError(envName, 'keystore kdfparams missing');
  const p = params as Record<string, unknown>;
  const salt = hexBytes(p.salt, envName, 'kdfparams.salt');
  const dklen = positiveInt(p.dklen, envName, 'kdfparams.dklen');
  if (dklen < 32) throw new KeystoreError(envName, 'keystore dklen below 32');
  if (kdf === 'scrypt') {
    const N = positiveInt(p.n, envName, 'kdfparams.n');
    const r = positiveInt(p.r, envName, 'kdfparams.r');
    const par = positiveInt(p.p, envName, 'kdfparams.p');
    // scrypt needs about 128 * N * r * p bytes; Node's default cap is 32 MiB, too small for N = 2^18.
    const maxmem = Math.max(32 * 1024 * 1024, 256 * N * r * par);
    return scryptSync(password, salt, dklen, { N, r, p: par, maxmem });
  }
  if (kdf === 'pbkdf2') {
    if (p.prf !== 'hmac-sha256') throw new KeystoreError(envName, 'keystore pbkdf2 prf must be hmac-sha256');
    const c = positiveInt(p.c, envName, 'kdfparams.c');
    return pbkdf2Sync(password, salt, c, dklen, 'sha256');
  }
  throw new KeystoreError(envName, 'keystore kdf must be scrypt or pbkdf2');
}

function keystorePath(envName: string, env: Env): string {
  const path = env[envName];
  if (path === undefined || path === '') throw new KeystoreError(envName, 'not set');
  if (!isAbsolute(path)) throw new KeystoreError(envName, 'must be an absolute path');
  return path;
}

function readOrFail(path: string, envName: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new KeystoreError(envName, `${what} could not be read`);
  }
}

/** Password file content, with trailing line breaks and spaces removed as Foundry does. */
function readPassword(path: string, envName: string): Buffer {
  const raw = readOrFail(`${path}.pass`, envName, 'password file');
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d || raw[end - 1] === 0x20 || raw[end - 1] === 0x09)) end--;
  const password = Buffer.from(raw.subarray(0, end));
  raw.fill(0);
  return password;
}

/**
 * Decrypts the Foundry v3 keystore named by `envName` (its password in `<file>.pass`) and returns
 * the 32 secp256k1 private key bytes. The caller owns the returned array and should zero it after
 * use. Never log it.
 */
export function loadKeyBytes(envName: string, env: Env = process.env): Uint8Array {
  const path = keystorePath(envName, env);
  const fileBytes = readOrFail(path, envName, 'keystore file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileBytes.toString('utf8'));
  } catch {
    throw new KeystoreError(envName, 'keystore file is not JSON');
  } finally {
    fileBytes.fill(0);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new KeystoreError(envName, 'keystore file is not an object');
  const doc = parsed as Record<string, unknown>;
  if (doc.version !== 3) throw new KeystoreError(envName, 'keystore version must be 3');
  const crypto = (doc.crypto ?? doc.Crypto) as Record<string, unknown> | undefined;
  if (typeof crypto !== 'object' || crypto === null) throw new KeystoreError(envName, 'keystore crypto section missing');
  if (crypto.cipher !== 'aes-128-ctr') throw new KeystoreError(envName, 'keystore cipher must be aes-128-ctr');
  const cipherparams = crypto.cipherparams as Record<string, unknown> | undefined;
  const iv = hexBytes(cipherparams?.iv, envName, 'cipherparams.iv');
  if (iv.length !== 16) throw new KeystoreError(envName, 'keystore iv must be 16 bytes');
  const ciphertext = hexBytes(crypto.ciphertext, envName, 'ciphertext');
  const mac = hexBytes(crypto.mac, envName, 'mac');
  if (ciphertext.length !== 32) throw new KeystoreError(envName, 'keystore ciphertext must be 32 bytes');
  if (mac.length !== 32) throw new KeystoreError(envName, 'keystore mac must be 32 bytes');

  const password = readPassword(path, envName);
  let dk: Buffer;
  try {
    dk = deriveKey(crypto, password, envName);
  } finally {
    password.fill(0);
  }
  try {
    const macInput = Buffer.concat([dk.subarray(16, 32), ciphertext]);
    const expected = Buffer.from(keccak256(macInput).slice(2), 'hex');
    if (!timingSafeEqual(expected, mac)) {
      throw new KeystoreError(envName, 'keystore could not be decrypted (wrong password or damaged file)');
    }
    const decipher = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), iv);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const key = new Uint8Array(plain);
    plain.fill(0);
    return key;
  } finally {
    dk.fill(0);
  }
}

/** viem account for the Foundry v3 keystore named by `envName`. */
export function loadSigner(envName: string, env: Env = process.env): PrivateKeyAccount {
  const key = loadKeyBytes(envName, env);
  try {
    return privateKeyToAccount(bytesToHex(key));
  } catch {
    throw new KeystoreError(envName, 'keystore does not hold a valid secp256k1 key');
  } finally {
    key.fill(0);
  }
}
