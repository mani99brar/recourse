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
import { inspectHederaTransaction } from '@x402/hedera';
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

/** The parts of the HTTP request a payment hook can see. */
export interface RequestView {
  header(name: string): string | undefined;
  path: string;
  paymentHeader: string | undefined;
}

export interface PaymentsOptions {
  facilitator: FacilitatorClient;
  routes: RoutesConfig;
  /**
   * Runs before the payment is verified or settled; return a reason to refuse it, so no money
   * moves. `payer` is the account the transfer debits.
   */
  beforePayment?: (payment: { payer: string; amount: string; asset: string; payTo: string }, request: RequestView) => Promise<string | null>;
  /** Called once per settled payment, before the handler runs. Must not throw. */
  onSettled?: (settled: SettledPayment, request: RequestView) => void;
}

/** The account debited by a Hedera `exact` payment payload, or null when it cannot be read. */
export function payerOfPayload(payload: unknown, requirements: { asset: string }): string | null {
  const tx = (payload as { payload?: { transaction?: unknown } })?.payload?.transaction;
  if (typeof tx !== 'string') return null;
  try {
    const info = inspectHederaTransaction(tx);
    const transfers = requirements.asset === HBAR_ASSET_ID ? info.hbarTransfers : (info.tokenTransfers[requirements.asset] ?? []);
    const debits = transfers.filter((t) => BigInt(t.amount) < 0n);
    return debits.length === 1 ? debits[0]!.accountId : null;
  } catch {
    return null;
  }
}

export function createPayments(options: PaymentsOptions): ShopPayments {
  const settlements = new SettlementBook();
  const resourceServer = new x402ResourceServer(options.facilitator).register(NETWORK, new ExactHederaScheme());
  resourceServer.onBeforeVerify(async (ctx) => {
    if (!options.beforePayment) return;
    const view = viewOf(ctx.transportContext);
    const payer = payerOfPayload(ctx.paymentPayload, ctx.requirements);
    if (!payer) return { abort: true, reason: 'payer_unreadable', message: 'the payment does not name one paying account' };
    const reason = await options.beforePayment(
      { payer, amount: ctx.requirements.amount, asset: ctx.requirements.asset, payTo: ctx.requirements.payTo },
      view,
    );
    return reason ? { abort: true, reason, message: reason } : undefined;
  });
  resourceServer.onAfterSettle(async (ctx) => {
    if (ctx.phase !== 'before-handler') return;
    const view = viewOf(ctx.transportContext);
    const r = ctx.result as SettleResponse;
    const settled: SettledPayment = {
      transaction: r.transaction,
      payer: r.payer ?? '',
      amount: r.amount ?? ctx.requirements.amount,
      asset: ctx.requirements.asset,
      payTo: ctx.requirements.payTo,
      network: r.network,
    };
    if (view.paymentHeader) settlements.put(view.paymentHeader, settled);
    options.onSettled?.(settled, view);
  });
  const httpServer = new x402HTTPResourceServer(resourceServer, options.routes);
  // Initialisation is explicit at boot (and after a facilitator switch), not on the first request.
  const middleware = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false) as RequestHandler;
  return { resourceServer, httpServer, middleware, settlements };
}

function viewOf(transportContext: unknown): RequestView {
  const adapter = (transportContext as { request?: { adapter?: { getHeader(name: string): string | undefined; getPath(): string } } })
    ?.request?.adapter;
  const header = (name: string) => adapter?.getHeader(name) ?? undefined;
  return {
    header,
    path: adapter?.getPath() ?? '',
    paymentHeader: header('payment-signature') ?? header('x-payment'),
  };
}
