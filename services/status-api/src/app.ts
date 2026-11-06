// The HTTP layer: the /v1 API (reads, actions, the OpenAPI file; see v1/router.ts) and the older
// unversioned read-only GET endpoints, CORS limited to the web origin, bigint as text.

import express, { type NextFunction, type Request, type Response } from 'express';
import { apiReplacer } from './json.js';
import { ApiError, type StatusService } from './service.js';
import { createV1Router, serveOpenapi, type V1Options } from './v1/router.js';

export function createApp(svc: StatusService, v1: V1Options = { chain: null }): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', apiReplacer);
  app.set('etag', false);

  app.use((req, res, next) => {
    const origin = svc.d.cfg.webOrigin;
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    if (req.method === 'OPTIONS') {
      const versioned = req.path === '/v1' || req.path.startsWith('/v1/');
      res.setHeader('access-control-allow-methods', versioned ? 'GET, POST' : 'GET');
      if (versioned) res.setHeader('access-control-allow-headers', 'content-type');
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/v1', createV1Router(svc, v1));
  app.get('/openapi.json', serveOpenapi);

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).json({ error: 'read_only' });
      return;
    }
    next();
  });

  // Every response carries how fresh each source is, which are late, the token its vault amounts
  // are in (the deployment's: Circle USDC, or the testnet mock mUSDC), and, until every contract
  // is locked, what the owner can still change.
  const wrap = (fn: (req: Request) => Promise<object> | object) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (svc.d.store.rebuilding) throw new ApiError(503, 'rebuilding');
      const body = await fn(req);
      const configLock = await svc.configLock();
      res.json({ ...body, asOf: svc.asOf(), degraded: svc.degraded(), vaultToken: svc.d.deployments.token, configLock });
    } catch (e) {
      next(e);
    }
  };

  app.get('/health', async (_req, res) => {
    res.json({ ...svc.health(), asOf: svc.asOf(), degraded: svc.degraded() });
  });
  app.get('/params', wrap(() => svc.paramsResponse()));
  app.get('/claims', wrap((req) => svc.claimsResponse(str(req.query.party), str(req.query.status))));
  app.get('/claims/:claimId', wrap((req) => svc.claimDetail(String(req.params.claimId))));
  app.get('/orders/:orderId/records', wrap((req) => svc.recordsOfOrder(String(req.params.orderId))));
  app.get('/parties/:address', wrap((req) => svc.party(String(req.params.address))));
  app.get('/search', wrap((req) => svc.search(str(req.query.q) ?? '')));

  app.use((_req, res) => {
    res.status(404).json({ error: 'unknown' });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      const body: Record<string, unknown> = { error: err.code };
      if (err.code === 'rebuilding') body.rebuilding = true;
      res.status(err.status).json(body);
      return;
    }
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
