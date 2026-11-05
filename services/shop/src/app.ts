// The shop's HTTP app: paid x402 routes under /x402/, plus free routes for health and the ERC-8004
// registration document. Payment settles before a paid handler runs; the handler journals the
// settlement before it replies.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { FacilitatorClient, RoutesConfig } from '@x402/core/server';
import { shopRegistration, type Journal, type Logger } from '@recourse/records';
import { HBAR_ASSET_ID, NETWORK, USDC_TOKEN_ID, createPayments, paidRoute, paymentHeaderOf, type Price, type SettledPayment, type ShopPayments } from './payments.js';
import type { ShopConfig } from './config.js';
import type { LadderState } from './facilitators.js';

export const PING_ROUTE = '/x402/ping-order';
/** Fixed price of the connectivity-check route: 0.05 USDC, or 0.1 HBAR when priced in HBAR. */
export const PING_PRICE_USDC = '50000';
export const PING_PRICE_TINYBAR = '10000000';

export type ShopJournalRow =
  | { type: 'settled'; at: string; route: string; txId: string; payer: string; amount: string; asset: string; payTo: string }
  | { type: 'ping_paid'; at: string; txId: string; payer: string; amount: string; asset: string };

export interface ShopAppDeps {
  config: ShopConfig;
  facilitator: FacilitatorClient & { state?: () => LadderState };
  journal: Journal<ShopJournalRow>;
  log: Logger;
  agentId?: string | null;
}

export interface ShopApp {
  app: Express;
  payments: ShopPayments;
  /** Reads /supported again; call at boot and after a facilitator switch. */
  initialize: () => Promise<void>;
}

export function pingPrice(config: ShopConfig): Price {
  return config.priceAsset === 'hbar'
    ? { amount: PING_PRICE_TINYBAR, asset: HBAR_ASSET_ID }
    : { amount: PING_PRICE_USDC, asset: USDC_TOKEN_ID };
}

export function createShopApp(deps: ShopAppDeps): ShopApp {
  const { config, journal, log } = deps;
  let lastError: string | null = null;

  const routes: RoutesConfig = {
    [`POST ${PING_ROUTE}`]: paidRoute(config.payTo, pingPrice(config), 'Connectivity check: a paid request that is not an order'),
  };

  const payments = createPayments({
    facilitator: deps.facilitator,
    routes,
    onSettled: (s: SettledPayment) => {
      try {
        journal.append({
          type: 'settled',
          at: new Date().toISOString(),
          route: 'x402',
          txId: s.transaction,
          payer: s.payer,
          amount: s.amount,
          asset: s.asset,
          payTo: s.payTo,
        });
        log.info('payment_settled', { txId: s.transaction, payer: s.payer, amount: s.amount, asset: s.asset });
      } catch (error) {
        lastError = `journal: ${error instanceof Error ? error.message : String(error)}`;
        log.error('journal_write_failed', { txId: s.transaction, error: lastError });
      }
    },
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '8kb' }));

  app.get('/health', (_req, res) => {
    const ladder = deps.facilitator.state?.();
    res.json({
      ok: true,
      service: 'shop',
      network: NETWORK,
      payTo: config.payTo,
      topicId: config.topicId,
      facilitator: ladder ? { rung: ladder.rung, url: ladder.url, consecutiveFailures: ladder.consecutiveFailures } : null,
      lastError: lastError ?? ladder?.lastError ?? null,
    });
  });

  app.get('/.well-known/agent-registration.json', (req, res) => {
    const base = config.publicUrl ?? `${req.protocol}://${req.get('host')}`;
    const doc = shopRegistration({
      name: config.displayName,
      x402BaseUrl: `${base}/x402/`,
      payTo: config.payTo,
      asset: config.priceAsset === 'hbar' ? HBAR_ASSET_ID : USDC_TOKEN_ID,
      network: NETWORK,
      ...(deps.agentId ? { agentId: deps.agentId } : {}),
    });
    res.json(doc);
  });

  app.use(payments.middleware);

  app.post(PING_ROUTE, (req, res) => {
    const settled = payments.settlements.take(paymentHeaderOf(req));
    if (!settled) {
      // The middleware only lets a paid request through, so this means the hook did not run.
      lastError = 'ping: settlement not captured';
      log.error('settlement_missing', { route: PING_ROUTE });
      res.status(500).json({ error: 'settlement_not_captured' });
      return;
    }
    journal.append({
      type: 'ping_paid',
      at: new Date().toISOString(),
      txId: settled.transaction,
      payer: settled.payer,
      amount: settled.amount,
      asset: settled.asset,
    });
    res.json({ ok: true, kind: 'ping', txId: settled.transaction, payer: settled.payer, amount: settled.amount, asset: settled.asset });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; type?: string }).status;
    if (status === 413) {
      res.status(413).json({ error: 'body_too_large' });
      return;
    }
    if (status === 400) {
      res.status(400).json({ error: 'bad_json' });
      return;
    }
    lastError = err instanceof Error ? err.message.slice(0, 200) : 'handler error';
    log.error('handler_error', { error: lastError });
    res.status(500).json({ error: 'internal' });
  });

  return {
    app,
    payments,
    initialize: () => payments.httpServer.initialize(),
  };
}
