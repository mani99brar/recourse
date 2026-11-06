// HTTP surface of the docket. Everything is answered from the journal and in-memory state, never
// by a live Arkiv read, so an Arkiv outage cannot slow an answer. The answers that carry amounts
// (`toShopUsdc`) name the deployment's vault token beside them; the entities themselves do not change.

import express, { type Express } from 'express';
import type { VaultToken } from '@recourse/shared';
import type { Docket } from './docket.js';
import { faultRates, type RateOptions } from './rates.js';

export interface AppDeps {
  docket: Docket;
  rate: RateOptions;
  store: 'arkiv' | 'local';
  /** The Hedera deployment's vault token; null when no deployment was read. */
  vaultToken?: VaultToken | null;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function createDocketApp({ docket, rate, store, vaultToken = null }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      store,
      vaultToken,
      ...docket.health(),
      rateConfig: { publishThreshold: rate.publishThreshold, sampleMode: rate.sampleMode, z: rate.z },
    });
  });

  app.get('/write-status/:claimId', (req, res) => {
    const id = req.params.claimId;
    if (!HEX32.test(id)) return void res.status(400).json({ error: 'claimId must be 32 bytes of hex' });
    const view = docket.writeStatus(id);
    if (view === null) return void res.status(404).json({ error: 'unknown claim' });
    res.json(view);
  });

  app.get('/docket/cases', (req, res) => {
    const { platform, shop, month } = req.query as Record<string, string | undefined>;
    if (platform !== undefined && !ADDR.test(platform)) return void res.status(400).json({ error: 'bad platform' });
    if (shop !== undefined && !ADDR.test(shop)) return void res.status(400).json({ error: 'bad shop' });
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const rows = docket
      .writtenCases()
      .filter(({ row }) => (platform === undefined || row.platform.toLowerCase() === platform.toLowerCase()) && (shop === undefined || row.shop.toLowerCase() === shop.toLowerCase()) && (month === undefined || row.month === month))
      .sort((a, b) => b.row.settledAt - a.row.settledAt || (a.claimId < b.claimId ? -1 : 1));
    res.json({ store, vaultToken, offset, total: rows.length, rows: rows.slice(offset, offset + 100).map(({ entityKey, row }) => ({ entityKey, ...row })) });
  });

  app.get('/docket/counts', (req, res) => {
    const { platform, shop, month } = req.query as Record<string, string | undefined>;
    const rows = docket
      .writtenCounts()
      .filter(({ row }) => (platform === undefined || row.platform.toLowerCase() === platform.toLowerCase()) && (shop === undefined || row.shop.toLowerCase() === shop.toLowerCase()) && (month === undefined || row.month === month));
    res.json({ store, rows: rows.map(({ entityKey, row }) => ({ entityKey, ...row })) });
  });

  app.get('/rates', (req, res) => {
    const { platform, shop } = req.query as Record<string, string | undefined>;
    if ((platform === undefined) === (shop === undefined)) return void res.status(400).json({ error: 'give exactly one of platform or shop' });
    const party = (platform ?? shop)!;
    if (!ADDR.test(party)) return void res.status(400).json({ error: 'bad address' });
    const results = faultRates(docket.rateRows(), { ...rate, closedUncontested: docket.closedUncontestedByParty() }).filter(
      (r) => r.party === party.toLowerCase() && r.role === (platform !== undefined ? 'platform' : 'shop'),
    );
    res.json({ party: party.toLowerCase(), rates: results });
  });

  return app;
}
