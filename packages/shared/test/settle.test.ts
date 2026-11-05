import { describe, expect, it } from 'vitest';
import { PARAMS, drawFromDeposit, settleOutcome } from '../src/index.js';
import { vector } from './vectors.js';

const v = vector('settle.json');
const params = {
  handlingBase: BigInt(v.params.handlingBase),
  handlingBps: BigInt(v.params.handlingBps),
  handlingCap: BigInt(v.params.handlingCap),
};
const big = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, x]) => [k, ['toShop', 'refundToShop', 'toPool', 'handling'].includes(k) ? BigInt(x as string) : x]));

describe('settle mirror', () => {
  it('the vectors use the live handling parameters and court fee', () => {
    for (const set of [PARAMS.preLock, PARAMS.locked]) {
      expect(params).toEqual({ handlingBase: BigInt(set.handlingBase), handlingBps: BigInt(set.handlingBps), handlingCap: BigInt(set.handlingCap) });
      expect(v.cases[0].input.feeUsdc).toBe(String(set.courtFeeUsdc));
    }
  });

  it.each((v.cases as any[]).map((c: any): [string, any] => [c.name, c]))('%s', (_n, c: any) => {
    const r = settleOutcome({
      ...c.input,
      basketUsdc: BigInt(c.input.basketUsdc),
      netLossUsdc: BigInt(c.input.netLossUsdc),
      feeUsdc: BigInt(c.input.feeUsdc),
      params,
    });
    expect(r).toEqual(big(c.expect));
    if (r.row !== 'not_settleable') expect(r.toPool + r.refundToShop).toBe(BigInt(c.input.feeUsdc));
  });

  it.each((v.drawFromDeposit as any[]).map((d: any): [string, string, any] => [d.owed, d.held, d]))('drawFromDeposit(%s, %s)', (_o, _h, d: any) => {
    expect(drawFromDeposit(BigInt(d.owed), BigInt(d.held))).toEqual({ paid: BigInt(d.paid), notCovered: BigInt(d.notCovered) });
  });
});
