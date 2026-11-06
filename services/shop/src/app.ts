// The shop's HTTP app: paid x402 routes under /x402/ (one per catalogue item and quantity, plus a
// connectivity check), and free routes for health, the catalogue, order status, complaints and the
// ERC-8004 registration document.
//
// A paid order request is checked before any payment is verified: known item, order headers,
// a body naming the order and the three records written before paying, no earlier order with the
// same id, and (when the check is on) a platform in good standing. The paying account must be one
// of the platform's record writers, checked before settlement. Payment settles before the handler
// runs; the order is journaled from the settlement hook, so it is never lost once paid.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import type { FacilitatorClient, RoutesConfig } from '@x402/core/server';
import { isHex32, orderIdOf, partyByAddress, priceAssetIdOf, type Parties } from '@recourse/shared';
import { shopRegistration, type Journal, type Logger, type TopicReader } from '@recourse/records';
import {
  CATALOG,
  MAX_QUANTITY,
  ORDER_ROUTE_PREFIX,
  basketPrice,
  itemBySku,
  offerAttrs,
  orderPath,
  type CatalogItem,
} from './catalog.js';
import type { ShopConfig } from './config.js';
import type { LadderState } from './facilitators.js';
import { ComplaintBody, OrderBody, OrderBook, type ShopJournalRow } from './orders.js';
import {
  HBAR_ASSET_ID,
  NETWORK,
  USDC_TOKEN_ID,
  createPayments,
  paidRoute,
  paymentHeaderOf,
  type Price,
  type RequestView,
  type SettledPayment,
  type ShopPayments,
} from './payments.js';
import type { StandingReader } from './standing.js';

export type { ShopJournalRow } from './orders.js';

export const PING_ROUTE = '/x402/ping-order';
/** Fixed price of the connectivity-check route: 0.05 USDC, or 0.1 HBAR when priced in HBAR. */
export const PING_PRICE_USDC = '50000';
export const PING_PRICE_TINYBAR = '10000000';

export const PLATFORM_HEADER = 'x-recourse-platform';
export const NONCE_HEADER = 'x-recourse-order-nonce';

export interface ShopAppDeps {
  config: ShopConfig & { shopAddress: Address };
  facilitator: FacilitatorClient & { state?: () => LadderState };
  journal: Journal<ShopJournalRow>;
  log: Logger;
  agentId?: string | null;
  /** The party map. Without it (local runs only) any platform is accepted and payers are not checked. */
  parties?: Parties | null;
  standing?: StandingReader | null;
  /** Topic reader, to check that a complaint points at a real arrived record. */
  reader?: TopicReader | null;
}

export interface ShopApp {
  app: Express;
  payments: ShopPayments;
  book: OrderBook;
  /** Reads /supported again; call at boot and after a facilitator switch. */
  initialize: () => Promise<void>;
}

export function pingPrice(config: ShopConfig): Price {
  return config.priceAsset === 'hbar'
    ? { amount: PING_PRICE_TINYBAR, asset: HBAR_ASSET_ID }
    : { amount: PING_PRICE_USDC, asset: USDC_TOKEN_ID };
}

interface OrderContext {
  orderId: Hex;
  orderNonce: Hex;
  platform: Address;
  item: CatalogItem;
  quantity: number;
  body: OrderBody | null;
}

/** Reads the order headers; null when either is missing or malformed. */
export function orderHeaders(header: (name: string) => string | undefined): { platform: Address; orderNonce: Hex } | null {
  const platform = header(PLATFORM_HEADER);
  const nonce = header(NONCE_HEADER);
  if (!platform || !isAddress(platform, { strict: false }) || !nonce || !isHex32(nonce)) return null;
  return { platform: getAddress(platform), orderNonce: nonce as Hex };
}

function parseOrderPath(path: string): { item: CatalogItem; quantity: number } | null {
  const m = new RegExp(`^${ORDER_ROUTE_PREFIX}/([a-z0-9-]+)/(\\d)$`).exec(path);
  if (!m) return null;
  const item = itemBySku(m[1]!);
  const quantity = Number(m[2]);
  if (!item || quantity < 1 || quantity > MAX_QUANTITY) return null;
  return { item, quantity };
}

export function createShopApp(deps: ShopAppDeps): ShopApp {
  const { config, journal, log } = deps;
  const parties = deps.parties ?? null;
  let lastError: string | null = null;

  const book = new OrderBook();
  for (const row of journal.rows()) book.apply(row);
  const write = (row: ShopJournalRow) => {
    journal.append(row);
    book.apply(row);
  };
  const now = () => new Date().toISOString();

  const routes: RoutesConfig = {
    [`POST ${PING_ROUTE}`]: paidRoute(config.payTo, pingPrice(config), 'Connectivity check: a paid request that is not an order'),
  };
  for (const item of CATALOG) {
    for (let q = 1; q <= MAX_QUANTITY; q++) {
      routes[`POST ${orderPath(item.sku, q)}`] = paidRoute(
        config.payTo,
        basketPrice(item, q, config.priceAsset),
        `${item.brand} ${item.title}, ${item.colour}, size ${item.size}, quantity ${q}`,
      );
    }
  }

  /** The platform's record writers must include the paying account. */
  const payerAllowed = (platform: Address, payer: string): boolean => {
    if (!parties) return true;
    const party = partyByAddress(parties, platform);
    return !!party && party.role === 'platform' && party.hcsWriters.includes(payer);
  };

  const payments = createPayments({
    facilitator: deps.facilitator,
    routes,
    beforePayment: async (payment, request) => {
      if (!parseOrderPath(request.path)) return null;
      const headers = orderHeaders(request.header);
      if (!headers) return 'bad_order_headers';
      return payerAllowed(headers.platform, payment.payer) ? null : 'payer_mismatch';
    },
    onSettled: (s: SettledPayment, request: RequestView) => {
      try {
        const route = parseOrderPath(request.path);
        const headers = orderHeaders(request.header);
        if (route && headers) {
          write({
            type: 'order_paid',
            at: now(),
            orderId: orderIdOf(headers.platform, config.shopAddress, headers.orderNonce),
            orderNonce: headers.orderNonce,
            platform: headers.platform,
            sku: route.item.sku,
            quantity: route.quantity,
            txId: s.transaction,
            payer: s.payer,
            amount: s.amount,
            asset: s.asset,
            payTo: s.payTo,
          });
        } else {
          write({ type: 'settled', at: now(), route: request.path, txId: s.transaction, payer: s.payer, amount: s.amount, asset: s.asset, payTo: s.payTo });
        }
        log.info('payment_settled', { path: request.path, txId: s.transaction, payer: s.payer, amount: s.amount, asset: s.asset });
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
    res.json(
      shopRegistration({
        name: config.displayName,
        x402BaseUrl: `${base}/x402/`,
        payTo: config.payTo,
        asset: priceAssetIdOf(config.priceAsset),
        network: NETWORK,
        ...(deps.agentId ? { agentId: deps.agentId } : {}),
      }),
    );
  });

  app.get('/catalog', (_req, res) => {
    res.json({
      merchant: config.displayName,
      network: NETWORK,
      payTo: config.payTo,
      asset: priceAssetIdOf(config.priceAsset),
      items: CATALOG.map((item) => ({
        sku: item.sku,
        title: item.title,
        offer: offerAttrs(item, 1, config.displayName),
        quantities: Array.from({ length: MAX_QUANTITY }, (_, i) => ({
          quantity: i + 1,
          path: orderPath(item.sku, i + 1),
          price: basketPrice(item, i + 1, config.priceAsset),
        })),
      })),
    });
  });

  app.get('/orders/:orderId', (req, res) => {
    // Re-read: the pack and complaint commands append to the same journal from other processes.
    const fresh = new OrderBook();
    for (const row of journal.read().rows) fresh.apply(row);
    const order = fresh.get(req.params.orderId) ?? book.get(req.params.orderId);
    if (!order) {
      res.status(404).json({ error: 'order_not_found' });
      return;
    }
    res.json({ order, inFlight: book.isInFlight(order.orderId) });
  });

  // Order check: runs before the payment middleware, so a refused order never reaches settlement.
  app.post(`${ORDER_ROUTE_PREFIX}/:sku/:qty`, async (req: Request, res: Response, next: NextFunction) => {
    const route = parseOrderPath(req.path);
    if (!route) {
      res.status(404).json({ error: 'unknown_item' });
      return;
    }
    const headers = orderHeaders((n) => req.header(n));
    if (!headers) {
      res.status(400).json({ error: 'bad_order_headers', expected: [PLATFORM_HEADER, NONCE_HEADER] });
      return;
    }
    if (parties) {
      const party = partyByAddress(parties, headers.platform);
      if (!party || party.role !== 'platform') {
        res.status(403).json({ error: 'unknown_platform' });
        return;
      }
    }
    const orderId = orderIdOf(headers.platform, config.shopAddress, headers.orderNonce);
    const existing = book.get(orderId);
    if (existing) {
      res.status(409).json({ error: 'order_exists', order: existing });
      return;
    }
    if (book.isInFlight(orderId)) {
      res.status(409).json({ error: 'order_in_flight', orderId });
      return;
    }
    if (config.standingCheck === 'vault') {
      let ok: boolean;
      try {
        if (!deps.standing) throw new Error('no standing reader');
        ok = await deps.standing.inGoodStanding(headers.platform);
      } catch (error) {
        log.warn('standing_unreadable', { platform: headers.platform, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        res.status(503).json({ error: 'standing_unreadable' });
        return;
      }
      if (!ok) {
        res.status(403).json({ error: 'platform_not_in_good_standing' });
        return;
      }
    }
    let body: OrderBody | null = null;
    if (paymentHeaderOf(req)) {
      const parsed = OrderBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'bad_order_body', issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')) });
        return;
      }
      if (parsed.data.orderId !== orderId) {
        res.status(400).json({ error: 'order_id_mismatch', orderId });
        return;
      }
      if (!book.begin(orderId)) {
        res.status(409).json({ error: 'order_in_flight', orderId });
        return;
      }
      res.on('close', () => book.end(orderId));
      body = parsed.data;
    }
    const ctx: OrderContext = { orderId, orderNonce: headers.orderNonce, platform: headers.platform, ...route, body };
    res.locals.order = ctx;
    next();
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
    write({ type: 'ping_paid', at: now(), txId: settled.transaction, payer: settled.payer, amount: settled.amount, asset: settled.asset });
    res.json({ ok: true, kind: 'ping', txId: settled.transaction, payer: settled.payer, amount: settled.amount, asset: settled.asset });
  });

  app.post(`${ORDER_ROUTE_PREFIX}/:sku/:qty`, (req, res) => {
    const ctx = res.locals.order as OrderContext | undefined;
    const settled = payments.settlements.take(paymentHeaderOf(req));
    if (!ctx || !ctx.body || !settled) {
      lastError = 'order: settlement not captured';
      log.error('settlement_missing', { path: req.path });
      res.status(500).json({ error: 'settlement_not_captured' });
      return;
    }
    if (!book.get(ctx.orderId)) {
      // The settlement hook could not journal it; do it now, before anything else.
      write({
        type: 'order_paid',
        at: now(),
        orderId: ctx.orderId,
        orderNonce: ctx.orderNonce,
        platform: ctx.platform,
        sku: ctx.item.sku,
        quantity: ctx.quantity,
        txId: settled.transaction,
        payer: settled.payer,
        amount: settled.amount,
        asset: settled.asset,
        payTo: settled.payTo,
      });
    }
    if (!payerAllowed(ctx.platform, settled.payer)) {
      write({ type: 'payer_mismatch', at: now(), orderId: ctx.orderId, payer: settled.payer, txId: settled.transaction });
      log.error('payer_mismatch', { orderId: ctx.orderId, payer: settled.payer, txId: settled.transaction });
      res.status(403).json({ error: 'payer_mismatch', orderId: ctx.orderId, txId: settled.transaction });
      return;
    }
    write({ type: 'order_confirmed', at: now(), orderId: ctx.orderId, refs: ctx.body.refs });
    res.json({
      ok: true,
      orderId: ctx.orderId,
      status: 'paid',
      txId: settled.transaction,
      payer: settled.payer,
      amount: settled.amount,
      asset: settled.asset,
      payTo: settled.payTo,
      offer: offerAttrs(ctx.item, ctx.quantity, config.displayName),
    });
  });

  app.post('/orders/:orderId/complaint', async (req, res) => {
    const parsed = ComplaintBody.safeParse(req.body);
    if (!parsed.success || parsed.data.orderId !== req.params.orderId) {
      res.status(400).json({ error: 'bad_complaint_body' });
      return;
    }
    const order = book.get(parsed.data.orderId);
    if (!order) {
      res.status(404).json({ error: 'order_not_found' });
      return;
    }
    if (order.complaint) {
      res.json({ ok: true, orderId: order.orderId, complaint: order.complaint, duplicate: true });
      return;
    }
    if (deps.reader) {
      const records = await deps.reader.readOrderRecords(order.orderId);
      const writers = parties ? partyByAddress(parties, order.platform)?.hcsWriters ?? [] : null;
      const found = records.find(
        (m) =>
          m.kind === 5 &&
          String(m.seq) === parsed.data.seq &&
          m.hash === parsed.data.hash &&
          m.cid === parsed.data.cid &&
          (writers === null || (m.payer !== null && writers.includes(m.payer))),
      );
      if (!found) {
        res.status(400).json({ error: 'complaint_not_on_topic' });
        return;
      }
    }
    write({ type: 'complaint', at: now(), orderId: order.orderId, seq: parsed.data.seq, hash: parsed.data.hash, cid: parsed.data.cid });
    res.json({ ok: true, orderId: order.orderId, complaint: { seq: parsed.data.seq, hash: parsed.data.hash, cid: parsed.data.cid } });
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
    book,
    initialize: () => payments.httpServer.initialize(),
  };
}
