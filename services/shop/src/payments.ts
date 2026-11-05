// x402 resource server for the shop: Hedera `exact` scheme, USDC on hedera:testnet, payment settled
// before the route handler runs. The handler learns the settlement (tx id, payer) through
// `SettlementBook`, filled by an after-settle hook keyed by the request's payment header.

import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type RouteConfig,
  type RoutesConfig,
} from '@x402/core/server';
import type { SettleResponse } from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { addressBook } from '@recourse/shared';
import type { Request, RequestHandler } from 'express';

export const NETWORK = 'hedera:testnet' as const;
export const USDC_TOKEN_ID = addressBook.hedera.usdc.tokenId;
export const HBAR_ASSET_ID = '0.0.0';
/** Settle before the handler, so a handler only ever runs for a payment that is final on chain. */
export const PAYMENT_FLOW = 'upfront' as const;

export interface Price {
  /** Atomic units: micro-USDC for USDC, tinybar for HBAR. */
  amount: string;
  asset: string;
}

export interface SettledPayment {
  transaction: string;
  payer: string;
  amount: string;
  asset: string;
  payTo: string;
  network: string;
}

/** Holds before-handler settlements until the handler for the same request takes them. */
export class SettlementBook {
  private readonly byHeader = new Map<string, SettledPayment>();

  put(paymentHeader: string, settled: SettledPayment): void {
    this.byHeader.set(paymentHeader, settled);
    // A handler normally takes its entry within milliseconds; drop strays so the map cannot grow.
    setTimeout(() => this.byHeader.delete(paymentHeader), 10 * 60_000).unref();
  }

  take(paymentHeader: string | undefined): SettledPayment | undefined {
    if (!paymentHeader) return undefined;
    const found = this.byHeader.get(paymentHeader);
    this.byHeader.delete(paymentHeader);
    return found;
  }
}

export function paymentHeaderOf(req: Request): string | undefined {
  return req.header('payment-signature') ?? req.header('x-payment') ?? undefined;
}

export function paidRoute(payTo: string, price: Price, description: string): RouteConfig {
  return {
    accepts: {
      scheme: 'exact',
      network: NETWORK,
      payTo,
      price: { amount: price.amount, asset: price.asset },
      extra: { paymentFlow: PAYMENT_FLOW },
    },
    description,
    mimeType: 'application/json',
  };
}

export interface ShopPayments {
  resourceServer: x402ResourceServer;
  httpServer: x402HTTPResourceServer;
  middleware: RequestHandler;
  settlements: SettlementBook;
}

export interface PaymentsOptions {
  facilitator: FacilitatorClient;
  routes: RoutesConfig;
  /** Called once per settled payment, before the handler runs. Must not throw. */
  onSettled?: (settled: SettledPayment, paymentHeader: string | undefined) => void;
}

export function createPayments(options: PaymentsOptions): ShopPayments {
  const settlements = new SettlementBook();
  const resourceServer = new x402ResourceServer(options.facilitator).register(NETWORK, new ExactHederaScheme());
  resourceServer.onAfterSettle(async (ctx) => {
    if (ctx.phase !== 'before-handler') return;
    const header = headerFromTransport(ctx.transportContext);
    const r = ctx.result as SettleResponse;
    const settled: SettledPayment = {
      transaction: r.transaction,
      payer: r.payer ?? '',
      amount: r.amount ?? ctx.requirements.amount,
      asset: ctx.requirements.asset,
      payTo: ctx.requirements.payTo,
      network: r.network,
    };
    if (header) settlements.put(header, settled);
    options.onSettled?.(settled, header);
  });
  const httpServer = new x402HTTPResourceServer(resourceServer, options.routes);
  // Initialisation is explicit at boot (and after a facilitator switch), not on the first request.
  const middleware = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false) as RequestHandler;
  return { resourceServer, httpServer, middleware, settlements };
}

function headerFromTransport(transportContext: unknown): string | undefined {
  const adapter = (transportContext as { request?: { adapter?: { getHeader(name: string): string | undefined } } })
    ?.request?.adapter;
  if (!adapter) return undefined;
  return adapter.getHeader('payment-signature') ?? adapter.getHeader('x-payment') ?? undefined;
}
