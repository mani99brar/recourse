// HTTP surface: health and per-claim results, answered from memory only. Bound to loopback.

import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { isHex32 } from '@recourse/shared';
import type { ResultView } from './service.js';

export interface HttpSource {
  health(): Record<string, unknown>;
  result(claimId: string): ResultView | undefined;
}

export function createApp(source: HttpSource): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json(source.health());
  });

  app.get('/results/:claimId', (req, res) => {
    const id = req.params.claimId.toLowerCase();
    if (!isHex32(id)) return void res.status(400).json({ error: 'claimId must be 32 bytes of hex' });
    const view = source.result(id);
    if (view === undefined) return void res.status(404).json({ error: 'unknown claim' });
    res.json(view);
  });

  return app;
}

/** Starts the server on 127.0.0.1. Port 0 picks a free one. */
export function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}
