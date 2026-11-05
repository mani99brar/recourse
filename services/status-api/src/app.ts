// The HTTP layer: read-only GET endpoints, CORS limited to the web origin, bigint as text.

import express, { type NextFunction, type Request, type Response } from 'express';
import { apiReplacer } from './json.js';
import { ApiError, type StatusService } from './service.js';

export function createApp(svc: StatusService): express.Express {
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
      res.setHeader('access-control-allow-methods', 'GET');
      res.status(204).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).json({ error: 'read_only' });
      return;
    }
    next();
  });

  // Every response carries how fresh each source is and which are late.
  const wrap = (fn: (req: Request) => Promise<object> | object) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (svc.d.store.rebuilding) throw new ApiError(503, 'rebuilding');
      const body = await fn(req);
      res.json({ ...body, asOf: svc.asOf(), degraded: svc.degraded() });
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
