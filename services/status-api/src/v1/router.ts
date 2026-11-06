// The /v1 HTTP layer: the same reads as the unversioned routes, each as `{ <resource>, meta }`, the
// actions under POST /v1/actions/{name}, the OpenAPI file, and one error shape. Action bodies are
// read as JSON whatever their content type (the web server in front does not pass it on yet), up
// to 64 KB. Actions are rate-limited per client, a few build at once, and each has a deadline
// below the web server's 15-second upstream timeout.

import { readFileSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { ClaimStatus, STATUS_KEYS, type OrderParties } from '@recourse/shared';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { ChainRevert, ChainUnavailable, type ActionReads } from '../chain.js';
import { safeError } from '../http.js';
import { foldClaim } from '../join.js';
import { ApiError, type StatusService } from '../service.js';
import { ACTIONS, ACTION_TARGET } from './actions.js';
import { ACTION_NAMES, isActionName, type ActionName } from './build.js';
import { V1Error, body, fromLegacy, invalid, missing, notFound, upstream } from './errors.js';
import { decodeRevert, revertError } from './reverts.js';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const BODY_LIMIT = 64 * 1024;
const STATUS_SET: ReadonlySet<string> = new Set(STATUS_KEYS);

/** The OpenAPI file, read once; served as is at /openapi.json and /v1/openapi.json. */
let openapiText: string | null = null;
export function openapiDocument(): string {
  if (openapiText === null) {
    const text = readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8');
    JSON.parse(text);
    openapiText = text;
  }
  return openapiText;
}

export function serveOpenapi(_req: Request, res: Response): void {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.send(openapiDocument());
}

export interface V1Options {
  /** Chain reads and simulation for the actions; null: every action answers upstream_unavailable. */
  chain: ActionReads | null;
  /** Milliseconds, for the rate limiter (tests move it). */
  nowMs?: () => number;
  /** How long a claim read waits on a shop's vault credit (tests shorten it); CREDIT_WAIT_MS when absent. */
  creditWaitMs?: number;
}

/**
 * How long a claim read waits on the credit of a shop that may withdraw, counted from when the
 * answer needs it: a cold read is eight eth_calls on the Hedera relay and can take tens of seconds,
 * past the web server's 15-second upstream timeout.
 */
const CREDIT_WAIT_MS = 3_000;

/** A token bucket per client; buckets idle long enough to refill are dropped, and the map is capped. */
export class Buckets {
  private m = new Map<string, { tokens: number; at: number }>();
  constructor(
    private perMin: number,
    private burst: number,
    private now: () => number = Date.now,
    private max = 10_000,
  ) {}
  take(key: string): { ok: true } | { ok: false; retryAfterS: number } {
    const t = this.now();
    const rate = this.perMin / 60_000;
    let b = this.m.get(key);
    if (!b) {
      if (this.m.size >= this.max) this.sweep(t);
      if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
      b = { tokens: this.burst, at: t };
      this.m.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (t - b.at) * rate);
    b.at = t;
    if (b.tokens < 1) return { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
    b.tokens -= 1;
    return { ok: true };
  }
  private sweep(t: number): void {
    const idle = (this.burst / this.perMin) * 60_000;
    for (const [k, b] of this.m) if (t - b.at >= idle) this.m.delete(k);
  }
}

/** The client a request counts against: Cloudflare's client address when it came through the local proxy. */
function clientOf(req: Request): string {
  const sock = req.socket.remoteAddress ?? 'unknown';
  const loopback = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  const cf = req.headers['cf-connecting-ip'];
  const v = (Array.isArray(cf) ? cf[0] : cf)?.trim();
  return (loopback && v ? v : sock).slice(0, 64);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function claimIdParam(v: unknown, field: string): Hex {
  if (typeof v !== 'string' || !HEX32.test(v)) throw invalid(field, 'expected 32 bytes, 0x and 64 hex digits');
  return v.toLowerCase() as Hex;
}

function addressParam(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v) || !isAddress(v, { strict: false })) throw invalid(field, 'expected an address, 0x and 40 hex digits');
  return getAddress(v);
}

type NextRow = { nextCall: string | null; nextActor: string; deadline: bigint | null; shop: Address; platform: Address };

/**
 * The action under /v1/actions that builds a claim's next call; null when there is none. A
 * withdrawCredit only while the account that would sign it has credit (`credit` read and above
 * zero): a settled or closed claim whose credit was already taken out has nothing left to do.
 */
export function nextActionOf(row: { nextCall: string | null; nextActor: string; deadline: bigint | null }, credit?: bigint | null) {
  if (!isActionName(row.nextCall)) return null;
  if (row.nextCall === 'withdrawCredit' && !(typeof credit === 'bigint' && credit > 0n)) return null;
  return { action: row.nextCall, actor: row.nextActor, path: `/v1/actions/${row.nextCall}`, deadline: row.deadline };
}

interface CreditReads {
  /** Starts the read of `a`'s credit, once a request. */
  start(a: Address): void;
  /** The credit when the read answers within `waitMs` from now, else the last one read for `a` (null before any). */
  of(a: Address): Promise<bigint | null>;
}

function creditReads(svc: StatusService, waitMs: number): CreditReads {
  const reads = new Map<Address, Promise<bigint | null>>();
  const read = (a: Address) => {
    let p = reads.get(a);
    if (!p) {
      p = svc.readCredit(a);
      reads.set(a, p);
    }
    return p;
  };
  return {
    start: (a) => void read(a),
    async of(a) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      });
      try {
        return (await Promise.race([read(a), late])) ?? svc.knownCredit(a);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Each row with its next action; the credit of an account that may withdraw is read once per request, waited on for a bounded time. */
async function withNextActions<T extends NextRow>(rows: T[], credits: CreditReads): Promise<(T & { nextAction: ReturnType<typeof nextActionOf> })[]> {
  return Promise.all(
    rows.map(async (row) => {
      const signer = row.nextCall === 'withdrawCredit' ? (row.nextActor === 'platform' ? row.platform : row.shop) : null;
      return { ...row, nextAction: nextActionOf(row, signer ? await credits.of(signer) : undefined) };
    }),
  );
}

export function createV1Router(svc: StatusService, opts: V1Options): Router {
  const r = express.Router();
  const cfg = svc.d.cfg;
  const buckets = new Buckets(cfg.actionsPerMin, cfg.actionBurst, opts.nowMs);
  const creditWaitMs = opts.creditWaitMs ?? CREDIT_WAIT_MS;
  let building = 0;

  const meta = async () => ({
    apiVersion: '1',
    asOf: svc.asOf(),
    degraded: svc.degraded(),
    vaultToken: svc.d.deployments.token,
    configLock: await svc.configLock(),
  });

  const notRebuilding = () => {
    if (svc.d.store.rebuilding) throw upstream('index', { rebuilding: true });
  };

  /** A read: `{ [key]: value, meta }`. */
  const read = (key: string, fn: (req: Request) => Promise<unknown> | unknown, opts2: { duringRebuild?: boolean } = {}) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!opts2.duringRebuild) notRebuilding();
        const value = await fn(req);
        res.json({ [key]: value, meta: await meta() });
      } catch (e) {
        next(e);
      }
    };

  const methodNotAllowed = (_req: Request, _res: Response, next: NextFunction) => next(new V1Error('method_not_allowed', 'This path does not take that method.'));

  r.route('/openapi.json').get(serveOpenapi).all(methodNotAllowed);
  r.route('/health').get(read('health', () => svc.health(), { duringRebuild: true })).all(methodNotAllowed);
  r.route('/params').get(read('params', async () => ({ ...(await svc.paramsResponse()), actions: [...ACTION_NAMES] }))).all(methodNotAllowed);
  // /claims answers two keys (claims and party), so it does not use the one-key reader.
  r.route('/claims')
    .get(async (req, res, next) => {
      try {
        notRebuilding();
        const party = str(req.query.party);
        const status = str(req.query.status);
        if (req.query.party !== undefined && party === undefined) throw invalid('party', 'give it once');
        if (req.query.status !== undefined && status === undefined) throw invalid('status', 'give it once');
        if (status !== undefined && !STATUS_SET.has(status)) throw invalid('status', `expected one of ${STATUS_KEYS.join(', ')}`);
        const addr = party === undefined ? undefined : addressParam(party, 'party');
        const out = await svc.claimsResponse(addr, status);
        const p = out as { rows: NextRow[]; standing?: unknown; groups?: unknown };
        res.json({
          claims: await withNextActions(p.rows, creditReads(svc, creditWaitMs)),
          party: addr === undefined ? null : { standing: p.standing, groups: p.groups },
          meta: await meta(),
        });
      } catch (e) {
        next(e);
      }
    })
    .all(methodNotAllowed);
  r.route('/claims/:claimId')
    .get(
      read('claim', async (req) => {
        const id = claimIdParam(req.params.claimId, 'claimId');
        // A settled or closed claim's next step is the shop's withdrawal: its credit is read alongside
        // the detail, which reads the chain too, rather than after it.
        const credits = creditReads(svc, creditWaitMs);
        const folded = foldClaim(svc.d.store.eventsOf(id));
        if (folded && (folded.status === ClaimStatus.Settled || folded.status === ClaimStatus.Closed)) credits.start(folded.shop);
        try {
          return (await withNextActions([await svc.claimDetail(id)], credits))[0];
        } catch (e) {
          if (e instanceof ApiError && e.code === 'unknown') throw notFound('claim', id);
          throw e;
        }
      }),
    )
    .all(methodNotAllowed);
  r.route('/parties/:address')
    .get(read('party', (req) => svc.party(addressParam(req.params.address, 'address'))))
    .all(methodNotAllowed);
  r.route('/orders/:orderId/records')
    .get(
      read('order', async (req) => {
        const id = claimIdParam(req.params.orderId, 'orderId');
        const platform = req.query.platform === undefined ? undefined : addressParam(req.query.platform, 'platform');
        const shop = req.query.shop === undefined ? undefined : addressParam(req.query.shop, 'shop');
        if ((platform === undefined) !== (shop === undefined)) throw missing(platform === undefined ? 'platform' : 'shop');
        // Once a claim names the order, its own platform's and shop's writers count; before that, the
        // platform and shop given, else a writer of any party of the role.
        let claimId: string | null = null;
        let order: OrderParties | undefined = platform && shop ? { platform, shop } : undefined;
        const store = svc.d.store;
        for (const cid of store.claimIds()) {
          const c = foldClaim(store.eventsOf(cid));
          if (c?.orderId === id) {
            claimId = cid;
            order = { platform: c.platform, shop: c.shop };
            break;
          }
        }
        const records = [];
        for (let k = 0; k < 6; k++) records.push(await svc.recordInfo(id, k, undefined, order));
        return { orderId: id, claimId, records };
      }),
    )
    .all(methodNotAllowed);
  r.route('/search')
    .get(
      read('search', (req) => {
        const q = str(req.query.q);
        if (q === undefined) throw req.query.q === undefined ? missing('q') : invalid('q', 'give it once');
        if (q.trim() === '') throw invalid('q', 'empty');
        if (q.length > 200) throw invalid('q', 'at most 200 characters');
        return svc.search(q);
      }),
    )
    .all(methodNotAllowed);

  // ------------------------------------------------------------------ actions

  const limit = (req: Request, res: Response, next: NextFunction) => {
    const t = buckets.take(clientOf(req));
    if (!t.ok) {
      req.resume();
      res.setHeader('retry-after', String(t.retryAfterS));
      next(new V1Error('rate_limited', 'Too many actions from this client; wait and try again.', { retryAfterS: t.retryAfterS }));
      return;
    }
    if (building >= cfg.actionConcurrency) {
      req.resume();
      res.setHeader('retry-after', '1');
      next(new V1Error('rate_limited', 'The API is building as many actions as it takes at once; try again in a second.', { retryAfterS: 1 }));
      return;
    }
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > BODY_LIMIT) {
      req.resume();
      next(new V1Error('payload_too_large', 'The body is over 64 KB.', { max: BODY_LIMIT }));
      return;
    }
    next();
  };

  const parseJson = express.json({ limit: BODY_LIMIT, strict: true, type: () => true });

  const run = async (req: Request, res: Response, next: NextFunction) => {
    const name = String(req.params.name) as ActionName;
    const target = ACTION_TARGET[name];
    const chain = opts.chain;
    if (!chain) {
      next(upstream(target.chain === 'hedera' ? 'hedera_rpc' : 'arbitrum_rpc', { reason: 'live chain reads are not configured' }));
      return;
    }
    building++;
    const work = ACTIONS[name]({ svc, ctx: { chain, dep: svc.d.deployments } }, req.body).finally(() => {
      building--;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(upstream(target.chain === 'hedera' ? 'hedera_rpc' : 'arbitrum_rpc', { reason: 'the chain did not answer in time' })), cfg.actionDeadlineMs);
    });
    try {
      res.json(await Promise.race([work, deadline]));
    } catch (e) {
      work.catch(() => undefined);
      if (e instanceof ChainUnavailable) next(upstream(e.chain === 'hedera' ? 'hedera_rpc' : 'arbitrum_rpc'));
      else if (e instanceof ChainRevert) next(revertError(decodeRevert(e.chain, target.contract, e.data)));
      else next(e);
    } finally {
      clearTimeout(timer);
    }
  };

  r.route('/actions/:name')
    .post((req, _res, next) => (isActionName(req.params.name) ? next() : next(notFound('route'))), limit, parseJson, run)
    .all((req, _res, next) => next(isActionName(req.params.name) ? new V1Error('method_not_allowed', 'Actions are built with POST.') : notFound('route')));

  r.use((_req, _res, next) => next(notFound('route')));

  r.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let e: V1Error;
    if (err instanceof V1Error) e = err;
    else if (err instanceof ApiError) e = fromLegacy(err.status, err.code);
    else if (isBodyError(err)) {
      e = err.type === 'entity.too.large' ? new V1Error('payload_too_large', 'The body is over 64 KB.', { max: BODY_LIMIT }) : new V1Error('bad_json', 'The body is not JSON, or not a JSON object.');
    } else {
      console.error(`status-api: ${req.method} ${req.path.slice(0, 80)} failed: ${safeError(err)}`);
      e = new V1Error('internal', 'An unexpected failure in the API.');
    }
    if (e.code === 'rate_limited' && !res.getHeader('retry-after')) res.setHeader('retry-after', String((e.details?.retryAfterS as number | undefined) ?? 1));
    res.status(e.status).json(body(e));
  });
  return r;
}

function isBodyError(e: unknown): e is { type: string } {
  return typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string' && typeof (e as { status?: unknown }).status === 'number';
}
