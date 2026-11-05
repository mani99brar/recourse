// Facilitator ladder: an ordered list of x402 facilitators behind one FacilitatorClient. At boot
// the first rung whose /supported lists `exact` on the network becomes active. After a run of
// consecutive settle failures on the facilitator's side (5xx, timeout, unreachable, malformed
// reply) it moves to the next working rung and calls `onSwitch`, so the resource server can
// re-read /supported: every 402 carries the active rung's fee payer, and a payment built for one
// rung's fee payer cannot be settled by another. A request in flight always finishes on the rung
// it started on.

import {
  FacilitatorResponseError,
  FacilitatorTimeoutError,
  HTTPFacilitatorClient,
  type FacilitatorClient,
} from '@x402/core/server';
import { SettleError, type PaymentPayload, type PaymentRequirements, type SettleResponse, type SupportedResponse, type VerifyResponse } from '@x402/core/types';
import type { Logger } from '@recourse/records';

export const SELF_HOSTED = 'self';

export interface RungSpec {
  /** Position in the ladder, from 1. */
  index: number;
  /** Facilitator base URL, or `self` for the in-process facilitator. */
  url: string;
  /** Built on first use, so the self-hosted rung loads its key only if the ladder reaches it. */
  create: () => FacilitatorClient;
}

export interface LadderOptions {
  network: string;
  scheme?: string;
  /** Consecutive facilitator-side settle failures before moving to the next rung. */
  failoverAfter?: number;
  log: Logger;
  onSwitch?: (from: RungSpec, to: RungSpec, reason: string) => Promise<void>;
}

export interface LadderState {
  rung: number;
  url: string;
  consecutiveFailures: number;
  lastError: string | null;
}

/** Splits X402_FACILITATOR_URLS (comma-separated; `self` names the in-process facilitator). */
export function parseFacilitatorUrls(text: string | undefined): string[] {
  const urls = (text ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s !== '');
  if (urls.length === 0) throw new Error('X402_FACILITATOR_URLS: not set');
  for (const u of urls) {
    if (u !== SELF_HOSTED && !/^https?:\/\//.test(u)) throw new Error(`X402_FACILITATOR_URLS: not a URL or "self": ${u}`);
  }
  return urls;
}

export function httpRung(index: number, url: string, timeoutMs = 30_000): RungSpec {
  return { index, url, create: () => new HTTPFacilitatorClient({ url, timeoutMs }) };
}

/** True for failures that say the facilitator, not the payment, is at fault. */
export function isFacilitatorSideFailure(error: unknown): boolean {
  if (error instanceof FacilitatorTimeoutError || error instanceof FacilitatorResponseError) return true;
  if (error instanceof SettleError) return error.statusCode >= 500;
  if (error instanceof TypeError) return true; // fetch could not reach the host
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    const m = /Facilitator \w+ failed \((\d{3})\)/.exec(error.message);
    if (m) return Number(m[1]) >= 500;
  }
  return false;
}

export function listsKind(supported: SupportedResponse, network: string, scheme: string): boolean {
  return supported.kinds.some((k) => k.network === network && k.scheme === scheme && k.x402Version === 2);
}

export class FacilitatorLadder implements FacilitatorClient {
  private readonly scheme: string;
  private readonly failoverAfter: number;
  private readonly clients = new Map<number, FacilitatorClient>();
  private activeIndex = -1;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private switching: Promise<void> | null = null;

  constructor(
    private readonly rungs: RungSpec[],
    private readonly options: LadderOptions,
  ) {
    if (rungs.length === 0) throw new Error('facilitator ladder: no rungs');
    this.scheme = options.scheme ?? 'exact';
    this.failoverAfter = options.failoverAfter ?? 3;
  }

  private client(rung: RungSpec): FacilitatorClient {
    let c = this.clients.get(rung.index);
    if (!c) {
      c = rung.create();
      this.clients.set(rung.index, c);
    }
    return c;
  }

  private get active(): RungSpec {
    const rung = this.rungs[this.activeIndex];
    if (!rung) throw new Error('facilitator ladder: no active rung (call select first)');
    return rung;
  }

  /** Picks the first rung at or after `from` whose /supported lists the kind. Throws if none does. */
  async select(from = 0): Promise<RungSpec> {
    const problems: string[] = [];
    for (let i = from; i < this.rungs.length; i++) {
      const rung = this.rungs[i]!;
      try {
        const supported = await this.client(rung).getSupported();
        if (listsKind(supported, this.options.network, this.scheme)) {
          this.activeIndex = i;
          this.consecutiveFailures = 0;
          this.options.log.info('facilitator_selected', { rung: rung.index, url: rung.url });
          return rung;
        }
        problems.push(`rung ${rung.index}: ${this.scheme} on ${this.options.network} not listed`);
      } catch (error) {
        problems.push(`rung ${rung.index}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.options.log.warn('facilitator_unusable', { rung: rung.index, url: rung.url, problem: problems.at(-1) });
    }
    throw new Error(`facilitator ladder: no usable rung (${problems.join('; ')})`);
  }

  state(): LadderState {
    const rung = this.rungs[this.activeIndex];
    return {
      rung: rung?.index ?? 0,
      url: rung?.url ?? '',
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }

  getSupported(): Promise<SupportedResponse> {
    return this.client(this.active).getSupported();
  }

  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.client(this.active).verify(paymentPayload, paymentRequirements);
  }

  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    const rung = this.active;
    try {
      const result = await this.client(rung).settle(paymentPayload, paymentRequirements);
      if (result.success) {
        if (rung === this.rungs[this.activeIndex]) this.consecutiveFailures = 0;
      } else {
        this.lastError = `rung ${rung.index}: ${result.errorReason ?? 'settle failed'}`;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `rung ${rung.index}: ${message}`;
      if (isFacilitatorSideFailure(error) && rung === this.rungs[this.activeIndex]) {
        this.consecutiveFailures += 1;
        this.options.log.warn('facilitator_settle_failed', {
          rung: rung.index,
          consecutive: this.consecutiveFailures,
          error: message.slice(0, 200),
        });
        if (this.consecutiveFailures >= this.failoverAfter) await this.advance(rung, message);
      }
      throw error;
    }
  }

  private async advance(from: RungSpec, reason: string): Promise<void> {
    if (this.switching) return this.switching;
    this.switching = (async () => {
      try {
        const fromPos = this.rungs.indexOf(from);
        let to: RungSpec;
        try {
          to = await this.select(fromPos + 1);
        } catch (error) {
          // No later rung works: stay where we are and keep counting.
          this.activeIndex = fromPos;
          this.options.log.error('facilitator_ladder_exhausted', {
            rung: from.index,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          });
          return;
        }
        this.options.log.warn('facilitator_switched', { from: from.index, to: to.index, reason: reason.slice(0, 200) });
        await this.options.onSwitch?.(from, to, reason);
      } finally {
        this.switching = null;
      }
    })();
    return this.switching;
  }
}
