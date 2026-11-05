import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { Alerter } from '../src/alerts.js';
import type { JournalRecord } from '../src/journal.js';

const CLAIM = `0x${'11'.repeat(32)}` as Hex;

function setup(fetchOk: () => boolean) {
  let now = 1_000_000;
  const journal: JournalRecord[] = [];
  const bodies: unknown[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    if (!fetchOk()) return new Response('down', { status: 503 });
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('ok', { status: 200 });
  };
  const make = () =>
    new Alerter({ service: 'keeper', url: 'http://alerts.invalid/hook', append: (r) => journal.push(r), now: () => now, fetch });
  return { make, journal, bodies, tick: (ms: number) => (now += ms) };
}

describe('alerts', () => {
  it('sends each (claim, kind) at most once per 30 minutes', async () => {
    const { make, tick, bodies } = setup(() => true);
    const a = make();
    expect(a.raise({ kind: 'send_late', claimId: CLAIM })).toBe(true);
    expect(a.raise({ kind: 'send_late', claimId: CLAIM })).toBe(false);
    expect(a.raise({ kind: 'open_late', claimId: CLAIM })).toBe(true);
    tick(29 * 60_000);
    expect(a.raise({ kind: 'send_late', claimId: CLAIM })).toBe(false);
    tick(60_001);
    expect(a.raise({ kind: 'send_late', claimId: CLAIM })).toBe(true);
    await a.flush();
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ service: 'keeper', kind: 'send_late', claimId: CLAIM });
  });

  it('keeps alerts journaled while the endpoint is down and sends them later, also after a restart', async () => {
    let up = false;
    const { make, journal, bodies } = setup(() => up);
    const a = make();
    a.raise({ kind: 'appeal_contribution', claimId: CLAIM, detail: { amount: '1' } });
    expect(await a.flush()).toEqual({ sent: 0, failed: 1 });
    const restarted = make();
    restarted.load(journal);
    expect(restarted.pending()).toHaveLength(1);
    expect(restarted.raise({ kind: 'appeal_contribution', claimId: CLAIM })).toBe(false);
    up = true;
    expect(await restarted.flush()).toEqual({ sent: 1, failed: 0 });
    expect(bodies).toHaveLength(1);
    const again = make();
    again.load(journal);
    expect(again.pending()).toEqual([]);
  });
});
