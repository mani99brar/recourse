// IPFS pinning and fetching. A document is packed into a one-block CAR locally, so its CID is fixed
// before upload; the provider imports the CAR; the client then fetches the document back through
// the gateway and checks its SHA-256 before anyone may reference it. Readers always check the hash
// of the bytes they fetch.
//
// The default provider is Filebase's S3-compatible API (CAR import through object metadata). The
// provider sits behind `PinProvider`, so another one can replace it.

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Hex } from 'viem';
import { recordHash } from '@recourse/shared';
import { hashOfCid, packCar } from './car.js';
import type { FetchLike } from './mirror.js';

/** Largest document this client pins or fetches. */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

export type IpfsErrorCode =
  | 'pin_not_configured'
  | 'pin_failed'
  | 'pin_mismatch'
  | 'document_too_large'
  | 'fetch_failed'
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
}

export interface IpfsOptions {
  gatewayUrl: string;
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

/** Fetches a document by CID through the gateway and returns its bytes only if their SHA-256 is `expectedHash`. */
export async function fetchDocument(cid: string, expectedHash: Hex, options: IpfsOptions): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const carried = hashOfCid(cid);
  if (carried !== null && carried !== expectedHash.toLowerCase()) {
    throw new IpfsError('hash_mismatch', `CID ${cid} does not carry the expected hash`);
  }
  return withRetries(
    async () => {
      const res = await fetchImpl(`${gatewayUrlFor(options.gatewayUrl, cid)}?format=raw`, {
        headers: { accept: 'application/vnd.ipld.raw, application/octet-stream, */*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
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
 * fetched back through the gateway must hash to the record hash. Otherwise `pin_mismatch`, and the
 * caller must not reference the document.
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
  try {
    await fetchDocument(cid, hash, options);
  } catch (error) {
    if (error instanceof IpfsError && error.code === 'hash_mismatch') throw new IpfsError('pin_mismatch', error.message);
    throw error;
  }
  return { cid, hash };
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

/**
 * The configured pin provider. Fails with `pin_not_configured`, naming the missing variable, when
 * IPFS_PIN_API_KEY, IPFS_PIN_API_SECRET or IPFS_PIN_BUCKET is not set.
 */
export function pinProviderFromEnv(env: Env = process.env): PinProvider {
  for (const name of ['IPFS_PIN_API_KEY', 'IPFS_PIN_API_SECRET', 'IPFS_PIN_BUCKET'] as const) {
    if (!env[name]) throw new IpfsError('pin_not_configured', `${name} is not set; documents cannot be pinned`);
  }
  return new FilebasePinProvider({
    endpoint: env.IPFS_PIN_API_URL || 'https://s3.filebase.com',
    accessKey: env.IPFS_PIN_API_KEY!,
    secret: env.IPFS_PIN_API_SECRET!,
    bucket: env.IPFS_PIN_BUCKET!,
  });
}

export function ipfsOptionsFromEnv(env: Env = process.env): IpfsOptions {
  if (!env.IPFS_GATEWAY_URL) throw new IpfsError('pin_not_configured', 'IPFS_GATEWAY_URL is not set; documents cannot be fetched');
  return { gatewayUrl: env.IPFS_GATEWAY_URL };
}
