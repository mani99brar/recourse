// GET /v1/cast: the demo cast. Every party in the party map with an ERC-8004 agent id, with its
// owner and agentURI read from the identity registry on Hedera, the name, description and
// `recourse` object of the registration document that URI names, the orders its records name on
// the records topic, and its claims with their outcomes.
//
// The registry is read through the Hedera JSON-RPC relay, at most once every REFRESH_S an agent.
// A request waits on it and on its other live reads for cfg.readWaitMs in all: slower reads finish
// in the background and are kept. A relay that fails or has not answered in time leaves the last
// values read, with `identity` in meta.degraded. A document is read from a `data:` URI, over HTTPS,
// or from IPFS through IPFS_GATEWAY_URL; nothing else is fetched.

import type { NextFunction, Request, Response } from 'express';
import { addressBook, erc8004IdentityAbi, type Party } from '@recourse/shared';
import { createPublicClient, fallback, http, type Address, type PublicClient } from 'viem';
import { ChainRevert, classify } from '../chain.js';
import { HttpError, getBytes } from '../http.js';
import { withDeadline, within } from '../lastgood.js';
import type { StatusService } from '../service.js';

const REFRESH_S = 30;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const KIND = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The two registry views the cast reads; tests pass a fake. */
export interface IdentityReads {
  ownerOf(agentId: bigint): Promise<Address>;
  tokenURI(agentId: bigint): Promise<string>;
}

export function viemIdentityReads(urls: string[], timeoutMs: number, registry: Address = addressBook.hedera.erc8004Identity): IdentityReads {
  const client = createPublicClient({ transport: fallback(urls.map((u) => http(u, { timeout: timeoutMs }))) }) as PublicClient;
  return {
    ownerOf: (agentId) => client.readContract({ address: registry, abi: erc8004IdentityAbi, functionName: 'ownerOf', args: [agentId] }),
    tokenURI: (agentId) => client.readContract({ address: registry, abi: erc8004IdentityAbi, functionName: 'tokenURI', args: [agentId] }),
  };
}

/** What the demo needs to say about a cast member: its role and its type, in a kebab-case slug and in plain words. */
export interface CastType {
  role: 'shop' | 'platform';
  kind: string;
  label: string;
  summary: string;
}

export interface CastRegistration {
  name: string | null;
  description: string | null;
  /** The document's `recourse` object; null when it has none or it does not validate. */
  recourse: CastType | null;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t.slice(0, max);
}

/** The fields the cast shows from a registration document. */
export function registrationOf(doc: unknown): CastRegistration {
  const o = typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
  let recourse: CastType | null = null;
  const r = o.recourse;
  if (typeof r === 'object' && r !== null && !Array.isArray(r)) {
    const x = r as Record<string, unknown>;
    const kind = typeof x.kind === 'string' && x.kind.length <= 64 && KIND.test(x.kind) ? x.kind : null;
    const label = text(x.label, 80);
    const summary = text(x.summary, 240);
    if ((x.role === 'shop' || x.role === 'platform') && kind && label && summary) recourse = { role: x.role, kind, label, summary };
  }
  return { name: text(o.name, 120), description: text(o.description, 600), recourse };
}

/** An agentURI this service does not fetch: an answer, not a failure. */
class UnsupportedUri extends Error {}

/**
 * A document error that is the host's answer, not a failure to reach it: inline JSON that does not
 * parse, a body that is not JSON, or a 4xx other than a timeout or a rate limit.
 */
function definite(err: unknown): boolean {
  if (err instanceof UnsupportedUri || err instanceof SyntaxError || err instanceof URIError) return true;
  return err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/** The registration document an agentURI names: inline, over HTTPS, or on IPFS through the gateway. */
async function fetchRegistration(svc: StatusService, uri: string): Promise<unknown> {
  const inline = /^data:application\/json(;base64)?,(.*)$/s.exec(uri);
  if (inline) {
    const body = inline[1] ? Buffer.from(inline[2]!, 'base64').toString('utf8') : decodeURIComponent(inline[2]!);
    if (body.length > MAX_DOCUMENT_BYTES) throw new UnsupportedUri('registration: document too large');
    return JSON.parse(body);
  }
  const gateway = svc.d.cfg.ipfsGatewayUrl;
  let url = uri;
  if (uri.startsWith('ipfs://')) {
    if (!gateway) throw new UnsupportedUri('registration: ipfs:// with no gateway');
    url = `${gateway}/ipfs/${uri.slice('ipfs://'.length)}`;
  } else if (!uri.startsWith('https://')) {
    throw new UnsupportedUri('registration: not a data:, https: or ipfs:// URI');
  }
  const bytes = await getBytes(svc.d.fetch, url, svc.d.cfg.sourceTimeoutMs);
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new UnsupportedUri('registration: document too large');
  return JSON.parse(new TextDecoder().decode(bytes));
}

interface Known {
  /** Null when the registry reverts for the id: no such agent. */
  owner: Address | null;
  agentURI: string | null;
  registration: CastRegistration | null;
  /** Unix seconds of the registry read. */
  readAt: number;
}

interface Entry {
  known: Known | null;
  /** The latest read failed (the relay or the document's host did not answer), or a request stopped waiting for it; cleared when a read succeeds. */
  failing: boolean;
  startedAt: number;
  pending: Promise<void> | null;
}

export interface CastOptions {
  /** Null: the registry is not read. Absent: read on HEDERA_RPC_URL_1/2. */
  identity?: IdentityReads | null;
  /** How long a request waits on the registry (cfg.readWaitMs when absent); the request's deadline still applies. */
  waitMs?: number;
}

export class Cast {
  private entries = new Map<string, Entry>();
  private identity: IdentityReads | null | undefined;
  private waitMs: number;

  constructor(
    private svc: StatusService,
    opts: CastOptions = {},
  ) {
    this.identity = opts.identity;
    this.waitMs = opts.waitMs ?? svc.d.cfg.readWaitMs;
  }

  /** Built on first use, so a router made without a relay costs nothing until /v1/cast is read. */
  private reads(): IdentityReads | null {
    if (this.identity === undefined) {
      const cfg = this.svc.d.cfg;
      this.identity = cfg.hederaRpcUrls.length > 0 ? viemIdentityReads(cfg.hederaRpcUrls, cfg.sourceTimeoutMs) : null;
    }
    return this.identity;
  }

  private entry(agentId: string): Entry {
    let e = this.entries.get(agentId);
    if (!e) {
      e = { known: null, failing: false, startedAt: -Infinity, pending: null };
      this.entries.set(agentId, e);
    }
    return e;
  }

  private async load(r: IdentityReads, agentId: string, e: Entry): Promise<void> {
    const id = BigInt(agentId);
    let owner: Address | null = null;
    let agentURI: string | null = null;
    try {
      [owner, agentURI] = await Promise.all([r.ownerOf(id), r.tokenURI(id)]);
    } catch (err) {
      // A revert is the registry's answer (no such agent); anything else keeps the last read.
      if (!(classify(err, 'hedera') instanceof ChainRevert)) {
        e.failing = true;
        return;
      }
    }
    const readAt = this.svc.d.nowS();
    let registration: CastRegistration | null = null;
    if (agentURI !== null) {
      try {
        registration = registrationOf(await fetchRegistration(this.svc, agentURI));
      } catch (err) {
        if (!definite(err)) {
          // The document's host did not answer: the last document read from the same URI stands in.
          const last = e.known;
          e.known = { owner, agentURI, registration: last?.agentURI === agentURI ? last.registration : null, readAt };
          e.failing = true;
          return;
        }
      }
    }
    e.known = { owner, agentURI, registration, readAt };
    e.failing = false;
  }

  /** Each agent's registry facts, read again when due; waits at most waitMs (or the request's deadline) on the reads. */
  private async refresh(agentIds: string[]): Promise<void> {
    const r = this.reads();
    if (!r) return;
    const now = this.svc.d.nowS();
    const waits: Promise<void>[] = [];
    for (const id of agentIds) {
      const e = this.entry(id);
      if (!e.pending && now - e.startedAt >= REFRESH_S) {
        e.startedAt = now;
        e.pending = this.load(r, id, e)
          .catch(() => {
            e.failing = true;
          })
          .finally(() => {
            e.pending = null;
          });
      }
      if (e.pending) waits.push(e.pending);
    }
    if (waits.length === 0) return;
    const done = await within(Promise.all(waits).then(() => true), this.waitMs, false);
    if (done) return;
    // A read still out is not current: its last values stand until it lands, as LastGood.get does.
    for (const id of agentIds) {
      const e = this.entry(id);
      if (e.pending) e.failing = true;
    }
  }

  private hashscan(path: string): string | null {
    const dep = this.svc.d.deployments;
    return dep.local || dep.hederaChainId !== addressBook.hedera.chainId ? null : `https://hashscan.io/testnet/${path}`;
  }

  /** The cast, and whether every registry fact in it is current. */
  async read() {
    const svc = this.svc;
    const members = (svc.d.parties() ?? []).filter((p): p is Party & { agentId: string } => p.agentId !== undefined);
    // The registry and the claims' live reads are waited on together, within the request's deadline.
    const [, rows] = await Promise.all([this.refresh(members.map((p) => p.agentId)), svc.claimRows()]);

    // Orders: the distinct order ids of the records each writer account paid for on the records topic.
    const ordersOf = new Map<string, Set<string>>();
    for (const rec of svc.d.store.hcs.values()) {
      let s = ordersOf.get(rec.payer);
      if (!s) ordersOf.set(rec.payer, (s = new Set()));
      s.add(rec.orderId);
    }
    const registry = addressBook.hedera.erc8004Identity;
    const reads = this.reads();
    let current = true;

    const out = members
      .map((p) => {
        const e = this.entries.get(p.agentId);
        const known = e?.known ?? null;
        const fresh = reads !== null && known !== null && !e?.failing;
        if (!fresh) current = false;
        const orders = new Set<string>();
        for (const w of p.hcsWriters) for (const o of ordersOf.get(w) ?? []) orders.add(o);
        const claims = rows
          .filter((r) => r.shop === p.evmAddress || r.platform === p.evmAddress)
          .map((r) => {
            const other = r.shop === p.evmAddress ? { address: r.platform, name: r.platformName } : { address: r.shop, name: r.shopName };
            return {
              claimId: r.claimId,
              orderId: r.orderId,
              statusKey: r.statusKey,
              answer: r.answer,
              findingSide: r.findingSide,
              paid: r.paid,
              filedAt: r.filedAt,
              counterparty: other.address,
              counterpartyName: other.name,
            };
          });
        return {
          agentId: p.agentId,
          role: p.role,
          displayName: p.displayName,
          address: p.evmAddress,
          hederaAccountId: p.hederaAccountId ?? null,
          owner: known?.owner ?? null,
          ownerIsParty: known ? known.owner !== null && known.owner === p.evmAddress : null,
          agentURI: known?.agentURI ?? null,
          registration: known?.registration ?? null,
          readAt: known?.readAt ?? null,
          current: fresh,
          explorer: this.hashscan(`contract/${registry}`),
          ownerExplorer: known?.owner ? this.hashscan(`account/${known.owner}`) : null,
          orders: orders.size,
          claims,
        };
      })
      .sort((a, b) => (BigInt(a.agentId) < BigInt(b.agentId) ? -1 : BigInt(a.agentId) > BigInt(b.agentId) ? 1 : 0));

    return {
      cast: {
        registry: {
          chainId: svc.d.deployments.hederaChainId,
          address: registry,
          accountId: addressBook.hedera.erc8004IdentityAccountId,
          explorer: this.hashscan(`contract/${registry}`),
        },
        members: out,
      },
      current,
    };
  }
}

type MetaOf = { degraded: string[] } & Record<string, unknown>;

/**
 * The /v1/cast handler: `{ cast, meta }`, with `identity` in meta.degraded while a registry fact is
 * not current. Like the other reads, its live reads wait cfg.readWaitMs in all and the config lock
 * is asked for alongside them.
 */
export function castRoute(
  svc: StatusService,
  deps: { meta: (lock?: ReturnType<StatusService['configLock']>) => Promise<MetaOf>; notRebuilding: () => void },
  opts: CastOptions = {},
) {
  const cast = new Cast(svc, opts);
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      deps.notRebuilding();
      const body = await withDeadline(svc.d.cfg.readWaitMs, async () => {
        const lock = svc.configLock();
        const { cast: value, current } = await cast.read();
        const meta = await deps.meta(lock);
        return { cast: value, meta: current ? meta : { ...meta, degraded: [...meta.degraded, 'identity'] } };
      });
      res.json(body);
    } catch (e) {
      next(e);
    }
  };
}
