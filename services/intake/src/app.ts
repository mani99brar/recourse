// Intake HTTP surface: size cap, per-IP rate limit, CORS for one origin, and the two endpoints.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { runIntake, type Fetcher, type IntakeRequest, type Pinner } from './intake.js';
import type { Tagger } from './tagger.js';

export interface AppDeps {
  tagger: Tagger;
  pinner?: Pinner;
  fetcher?: Fetcher;
  maxBytes: number;
  ratePerMin: number;
  corsOrigin: string | undefined;
  now: () => number; // unix seconds
  onTag?: (tag: string) => void;
  stats: () => Record<string, number>;
}

export function createIntakeApp(d: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  const hits = new Map<string, number[]>();

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (d.corsOrigin !== undefined && origin === d.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
    }
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true, llmStatus: d.tagger.status }));
  app.get('/intake/stats', (_req, res) => res.json({ counts: d.stats() }));

  app.post(
    '/intake',
    (req, res, next) => {
      const ip = req.ip ?? 'unknown';
      const t = d.now();
      const recent = (hits.get(ip) ?? []).filter((x) => t - x < 60);
      if (recent.length >= d.ratePerMin) return void res.status(429).json({ error: 'too many requests' });
      recent.push(t);
      hits.set(ip, recent);
      const len = Number(req.headers['content-length'] ?? 0);
      if (len > d.maxBytes) return void res.status(413).json({ error: 'body too large' });
      next();
    },
    express.json({ limit: d.maxBytes }),
    async (req, res) => {
      const body = req.body as IntakeRequest | undefined;
      if (body === undefined || typeof body !== 'object' || Array.isArray(body)) return void res.status(400).json({ error: 'expected a JSON object' });
      if (body.complaint !== undefined && typeof body.complaint !== 'string') return void res.status(400).json({ error: 'complaint must be text' });
      const out = await runIntake(body, { tagger: d.tagger, ...(d.pinner ? { pinner: d.pinner } : {}), ...(d.fetcher ? { fetcher: d.fetcher } : {}) });
      d.onTag?.(out.llmTag ?? 'none');
      res.json(out);
    },
  );

  app.use((err: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status === 413 ? 413 : err.status === 400 ? 400 : 500;
    res.status(status).json({ error: status === 413 ? 'body too large' : status === 400 ? 'bad request' : 'server error' });
  });
  return app;
}
