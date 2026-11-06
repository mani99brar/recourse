// IPFS pinning and fetching. A document is packed into a one-block CAR locally, so its CID is fixed
// before upload; the provider imports the CAR; the client then reads the document back and checks
// its SHA-256 before anyone may reference it. Readers always check the hash of the bytes they fetch.
//
// Two providers sit behind `PinProvider`:
// - Filebase's S3-compatible API (CAR import through object metadata), used whenever
//   IPFS_PIN_API_KEY, IPFS_PIN_API_SECRET and IPFS_PIN_BUCKET are all set;
// - a content store on this host, selected by IPFS_PIN_API_URL=file:///<absolute dir>. Each
//   document is one file, `<dir>/<cid>`, holding the raw block bytes. Every service on the host
//   shares the directory, and readers look there before the gateway. The CIDs are the ones Filebase
//   would report for the same bytes, so records written against the store stay valid after a switch.

import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CarBufferReader } from '@ipld/car/buffer-reader';
import type { Hex } from 'viem';
import { recordHash } from '@recourse/shared';
import { cidOfHash, hashOfCid, packCar } from './car.js';
import type { FetchLike } from './mirror.js';

/** Largest document this client pins or fetches. */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/**
 * `not_found` is a definite miss: the gateway answered 404 (after the retries), the local store
 * does not hold the document and there is no gateway to ask, or the CID is not one this client can
 * fetch (not a raw SHA-256 CID and no hash given). `fetch_failed` is everything that may pass on a
 * later try (network errors, timeouts, other gateway statuses, a damaged local copy).
 */
export type IpfsErrorCode =
  | 'pin_not_configured'
  | 'pin_failed'
  | 'pin_mismatch'
  | 'document_too_large'
  | 'fetch_failed'
  | 'not_found'
  | 'hash_mismatch';

export class IpfsError extends Error {
  constructor(
    readonly code: IpfsErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'IpfsError';
  }
}

export interface PinProvider {
  readonly name: string;
  /** Imports a CAR and returns the root CID the provider reports. */
  pinCar(car: Uint8Array, rootCid: string): Promise<{ cid: string }>;
  /**
   * For a provider that stores on this host: the stored bytes of a CID, checked against the hash
   * the CID carries, or null when it is not stored. A pin is then confirmed here, not through the
   * gateway.
   */
  readPinned?(cid: string): Promise<Uint8Array | null>;
}

export interface IpfsOptions {
  /** Gateway base URL. Optional when `localDir` is set; a document missing there then fails. */
  gatewayUrl?: string;
  /** Local content store read before the gateway. */
  localDir?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  /** Delay before retry n (1-based), in ms. */
  backoffMs?: (attempt: number) => number;
}

const defaultBackoff = (attempt: number) => 1000 * 2 ** attempt;

async function withRetries<T>(fn: () => Promise<T>, retries: number, backoff: (n: number) => number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoff(attempt)));
    try {
      return await fn();
    } catch (error) {
      if (error instanceof IpfsError && (error.code === 'hash_mismatch' || error.code === 'pin_mismatch' || error.code === 'document_too_large')) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

function gatewayUrlFor(gatewayUrl: string, cid: string): string {
  const base = gatewayUrl.replace(/\/+$/, '');
  return base.endsWith('/ipfs') ? `${base}/${cid}` : `${base}/ipfs/${cid}`;
}

/**
 * Reads the document whose record hash is `hash` from a local content store: null when it is not
 * there; `fetch_failed` when the stored copy does not hash to its CID (a damaged store, not a bad
 * document; pinning the document again repairs it). The file name is the canonical CID built from
 * the hash, never a caller's string, so no input can name a path outside the store.
 */
async function readLocalDocument(dir: string, hash: Hex): Promise<Uint8Array | null> {
  const cid = cidOfHash(hash).toString();
  const path = join(dir, cid);
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IpfsError('fetch_failed', `local store ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { size } = await handle.stat();
    if (size > MAX_DOCUMENT_BYTES) throw new IpfsError('document_too_large', `${cid} is ${size} bytes`);
    const bytes = new Uint8Array(await handle.readFile());
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new IpfsError('document_too_large', `${cid} is ${bytes.length} bytes`);
    if (recordHash(bytes) !== hash) {
      throw new IpfsError('fetch_failed', `local store copy ${path} is damaged: it does not hash to its CID; pin the document again`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Fetches a document by CID and returns its bytes only if their SHA-256 is `expectedHash`. With
 * `localDir` set, the local store is read first and the gateway only for a document not stored
 * there.
 */
export async function fetchDocument(cid: string, expectedHash: Hex, options: IpfsOptions): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const carried = hashOfCid(cid);
  if (carried !== null && carried !== expectedHash.toLowerCase()) {
    throw new IpfsError('hash_mismatch', `CID ${cid} does not carry the expected hash`);
  }
  if (options.localDir && carried !== null) {
    const local = await readLocalDocument(options.localDir, carried);
    if (local) return local;
  }
  const gatewayUrl = options.gatewayUrl;
  if (!gatewayUrl) {
    if (options.localDir) throw new IpfsError('not_found', `${cid} is not in the local store and IPFS_GATEWAY_URL is not set`);
    throw new IpfsError('fetch_failed', 'IPFS_GATEWAY_URL is not set; documents cannot be fetched');
  }
  return withRetries(
    async () => {
      const res = await fetchImpl(`${gatewayUrlFor(gatewayUrl, cid)}?format=raw`, {
        headers: { accept: 'application/vnd.ipld.raw, application/octet-stream, */*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) throw new IpfsError('not_found', `gateway answered 404 for ${cid}`);
      if (!res.ok) throw new IpfsError('fetch_failed', `gateway answered ${res.status} for ${cid}`);
      const length = Number(res.headers.get('content-length') ?? '0');
      if (length > MAX_DOCUMENT_BYTES) throw new IpfsError('document_too_large', `${cid} is ${length} bytes`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_DOCUMENT_BYTES) throw new IpfsError('document_too_large', `${cid} is ${bytes.length} bytes`);
      if (recordHash(bytes) !== expectedHash.toLowerCase()) {
        throw new IpfsError('hash_mismatch', `bytes at ${cid} do not hash to the expected value`);
      }
      return bytes;
    },
    options.retries ?? 3,
    options.backoffMs ?? defaultBackoff,
  );
}

export interface Pinned {
  cid: string;
  hash: Hex;
}

/**
 * Pins a document and confirms it: the provider must report the CID computed locally, and the bytes
 * read back (from the provider's own store when it is on this host, else through the gateway) must
 * hash to the record hash. Otherwise `pin_mismatch`, and the caller must not reference the
 * document.
 */
export async function pinDocument(bytes: Uint8Array, provider: PinProvider, options: IpfsOptions): Promise<Pinned> {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new IpfsError('document_too_large', `${bytes.length} bytes`);
  const { car, rootCid, hash } = packCar(bytes);
  const cid = rootCid.toString();
  const retries = options.retries ?? 3;
  const backoff = options.backoffMs ?? defaultBackoff;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const reported = await withRetries(
    async () => {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new IpfsError('pin_failed', `${provider.name} timed out after ${timeoutMs} ms`)), timeoutMs).unref(),
      );
      return Promise.race([provider.pinCar(car, cid), timeout]);
    },
    retries,
    backoff,
  ).catch((error: unknown) => {
    if (error instanceof IpfsError) throw error;
    throw new IpfsError('pin_failed', `${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (reported.cid !== cid) {
    throw new IpfsError('pin_mismatch', `${provider.name} reported ${reported.cid}, expected ${cid}`);
  }
  if (provider.readPinned) {
    let stored: Uint8Array | null;
    try {
      stored = await provider.readPinned(cid);
    } catch (error) {
      throw new IpfsError('pin_mismatch', `${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stored) throw new IpfsError('pin_mismatch', `${provider.name} does not hold ${cid} after pinning it`);
    return { cid, hash };
  }
  // A remote pin is confirmed through the gateway alone; a copy in a local store says nothing about it.
  const { localDir: _local, ...remote } = options;
  try {
    await fetchDocument(cid, hash, remote);
  } catch (error) {
    if (error instanceof IpfsError && error.code === 'hash_mismatch') throw new IpfsError('pin_mismatch', error.message);
    throw error;
  }
  return { cid, hash };
}

/**
 * Content store on this host: one file per document, `<dir>/<cid>`, holding the raw block. A pin
 * checks that the CAR holds exactly one block whose bytes hash to its CID, writes the file through
 * a temporary name, flushes it and renames it into place, so a reader sees the whole document or
 * none. Pinning a document that is already stored intact writes nothing.
 */
export class LocalPinProvider implements PinProvider {
  readonly name = 'local';

  constructor(readonly dir: string) {}

  async pinCar(car: Uint8Array, rootCid: string): Promise<{ cid: string }> {
    let reader: CarBufferReader;
    try {
      reader = CarBufferReader.fromBytes(car);
    } catch (error) {
      throw new IpfsError('pin_failed', `local store: not a CAR (${error instanceof Error ? error.message : String(error)})`);
    }
    const roots = reader.getRoots().map(String);
    const blocks = reader.blocks();
    if (roots.length !== 1 || blocks.length !== 1) {
      throw new IpfsError('pin_failed', `local store takes a CAR of one root and one block, got ${roots.length} and ${blocks.length}`);
    }
    const block = blocks[0]!;
    const hash = recordHash(block.bytes);
    const cid = cidOfHash(hash).toString();
    if (block.cid.toString() !== cid || roots[0] !== cid) {
      throw new IpfsError('pin_mismatch', `local store: the block hashes to ${cid}, the CAR names ${roots[0]} (pin asked for ${rootCid})`);
    }
    if (block.bytes.length > MAX_DOCUMENT_BYTES) throw new IpfsError('document_too_large', `${block.bytes.length} bytes`);
    const intact = await readLocalDocument(this.dir, hash).catch((error: unknown) => {
      // A damaged copy is written again.
      if (error instanceof IpfsError && (error.code === 'fetch_failed' || error.code === 'document_too_large')) return null;
      throw error;
    });
    if (!intact) await this.write(cid, block.bytes);
    return { cid };
  }

  async readPinned(cid: string): Promise<Uint8Array | null> {
    const hash = hashOfCid(cid);
    return hash === null ? null : readLocalDocument(this.dir, hash);
  }

  private async write(cid: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.tmp-${cid}-${process.pid}-${randomBytes(4).toString('hex')}`);
    try {
      const file = await open(tmp, 'wx', 0o644);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, join(this.dir, cid));
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw new IpfsError('pin_failed', `local store ${this.dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const dir = await open(this.dir, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}

export interface FilebaseConfig {
  endpoint: string;
  accessKey: string;
  secret: string;
  bucket: string;
}

/** Filebase S3-compatible pinning: PUT the CAR with `import: car` metadata, read the CID back with HEAD. */
export class FilebasePinProvider implements PinProvider {
  readonly name = 'filebase';
  private readonly s3: S3Client;

  get endpoint(): string {
    return this.config.endpoint;
  }

  constructor(private readonly config: FilebaseConfig) {
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secret },
    });
  }

  async pinCar(car: Uint8Array, rootCid: string): Promise<{ cid: string }> {
    const key = `recourse/${rootCid}.car`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: car,
        ContentType: 'application/vnd.ipld.car',
        Metadata: { import: 'car' },
      }),
    );
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
    const cid = head.Metadata?.cid;
    if (!cid) throw new IpfsError('pin_failed', 'filebase returned no cid for the uploaded CAR');
    return { cid };
  }
}

type Env = Record<string, string | undefined>;

/** Store used for `IPFS_PIN_API_URL=file://` with no directory. */
export const DEFAULT_LOCAL_STORE_DIR = join(homedir(), '.local/state/recourse/ipfs');

const FILEBASE_ENDPOINT = 'https://s3.filebase.com';
const FILEBASE_VARS = ['IPFS_PIN_API_KEY', 'IPFS_PIN_API_SECRET', 'IPFS_PIN_BUCKET'] as const;

/**
 * The local content store directory IPFS_PIN_API_URL names (`file:///<absolute dir>`), the default
 * store for `file://` with no directory, or null when the URL is not a file URL.
 */
export function localStoreDirFromEnv(env: Env = process.env): string | null {
  const url = env.IPFS_PIN_API_URL?.trim();
  if (!url || !/^file:/i.test(url)) return null;
  let dir: string;
  try {
    dir = fileURLToPath(new URL(url));
  } catch (error) {
    throw new IpfsError('pin_not_configured', `IPFS_PIN_API_URL ${url} is not a usable file URL (${error instanceof Error ? error.message : String(error)})`);
  }
  dir = dir.replace(/\/+$/, '');
  return dir === '' ? DEFAULT_LOCAL_STORE_DIR : dir;
}

/**
 * The configured pin provider: Filebase whenever IPFS_PIN_API_KEY, IPFS_PIN_API_SECRET and
 * IPFS_PIN_BUCKET are all set (IPFS_PIN_API_URL is its endpoint when that is an http(s) URL), else
 * the local content store when IPFS_PIN_API_URL is a file URL. Otherwise `pin_not_configured`,
 * naming what to set.
 */
export function pinProviderFromEnv(env: Env = process.env): PinProvider {
  const missing = FILEBASE_VARS.filter((name) => !env[name]);
  const url = env.IPFS_PIN_API_URL?.trim() || '';
  if (missing.length === 0) {
    if (url && !/^https?:\/\//i.test(url) && !/^file:/i.test(url)) {
      throw new IpfsError('pin_not_configured', `IPFS_PIN_API_URL must be an http(s) endpoint or a file:// directory, got ${url}`);
    }
    return new FilebasePinProvider({
      endpoint: /^https?:\/\//i.test(url) ? url : FILEBASE_ENDPOINT,
      accessKey: env.IPFS_PIN_API_KEY!,
      secret: env.IPFS_PIN_API_SECRET!,
      bucket: env.IPFS_PIN_BUCKET!,
    });
  }
  const localDir = localStoreDirFromEnv(env);
  if (localDir) return new LocalPinProvider(localDir);
  throw new IpfsError(
    'pin_not_configured',
    `${missing[0]} is not set; documents cannot be pinned. Set IPFS_PIN_API_KEY, IPFS_PIN_API_SECRET and IPFS_PIN_BUCKET to pin to Filebase, or IPFS_PIN_API_URL=file:///<dir> to keep documents in a store on this host`,
  );
}

/**
 * Fetch options: the gateway (IPFS_GATEWAY_URL) and, when IPFS_PIN_API_URL is a file URL, the local
 * store read before it. Fails with `pin_not_configured` when neither is set.
 */
export function ipfsOptionsFromEnv(env: Env = process.env): IpfsOptions {
  const localDir = localStoreDirFromEnv(env);
  const gatewayUrl = env.IPFS_GATEWAY_URL?.trim();
  if (!gatewayUrl && !localDir) {
    throw new IpfsError('pin_not_configured', 'IPFS_GATEWAY_URL is not set; documents cannot be fetched');
  }
  return { ...(gatewayUrl ? { gatewayUrl } : {}), ...(localDir ? { localDir } : {}) };
}

export interface PinClient {
  readonly provider: PinProvider;
  readonly options: IpfsOptions;
  /** The local content store this host reads first, or null. */
  readonly localDir: string | null;
  /** Pins a document and confirms it (see `pinDocument`). */
  pin(bytes: Uint8Array): Promise<Pinned>;
  /**
   * Fetches a document and checks its SHA-256 against `expectedHash`, or, when that is left out,
   * against the hash a raw SHA-256 CID carries.
   */
  fetch(cid: string, expectedHash?: Hex): Promise<Uint8Array>;
}

/**
 * Pinning and fetching as configured by the environment (`pinProviderFromEnv` and
 * `ipfsOptionsFromEnv`). Fails at once, naming what to set, when either is not configured.
 */
export function openPinClient(env: Env = process.env, overrides: Partial<IpfsOptions> = {}): PinClient {
  const provider = pinProviderFromEnv(env);
  const options: IpfsOptions = { ...ipfsOptionsFromEnv(env), ...overrides };
  return {
    provider,
    options,
    localDir: options.localDir ?? null,
    pin: (bytes) => pinDocument(bytes, provider, options),
    fetch: (cid, expectedHash) => {
      const hash = expectedHash ?? hashOfCid(cid);
      if (!hash) return Promise.reject(new IpfsError('not_found', `${cid} is not a raw SHA-256 CID; pass the expected hash`));
      return fetchDocument(cid, hash, options);
    },
  };
}
