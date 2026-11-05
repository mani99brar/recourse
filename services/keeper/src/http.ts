// Read-only HTTP surface on 127.0.0.1: GET /health and GET /claims/:claimId, both answered from
// the keeper's memory. Nothing here changes state; keeper-ctl writes the control file instead.

import type { Server } from 'node:http';
import express, { type Express } from 'express';

export interface KeeperHttpSource {
  health(): Record<string, unknown>;
  claim(claimId: string): Record<string, unknown> | undefined;
}

const HEX32 = /^0x[0-9a-f]{64}$/;

export function createKeeperApp(source: KeeperHttpSource): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.json(source.health());
  });
  app.get('/claims/:claimId', (req, res) => {
    const id = req.params.claimId.toLowerCase();
    if (!HEX32.test(id)) return void res.status(400).json({ error: 'claimId must be 32 bytes of hex' });
    const v = source.claim(id);
    if (v === undefined) return void res.status(404).json({ error: 'unknown claim' });
    res.json(v);
  });
  return app;
}

/** Starts the server on 127.0.0.1. Port 0 picks a free one. */
export function listenKeeper(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

/** JSON-safe copy: bigints become decimal strings. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === 'object' && v !== null) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = jsonSafe(x);
    return o;
  }
  return v;
}
