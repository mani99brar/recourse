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

  /** An endpoint that answers `status` to the kinds in `refuse` and 200 to the rest. */
  function refusing(refuse: Set<string>, status = 400) {
    const journal: JournalRecord[] = [];
    const posted: string[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { kind: string };
      if (refuse.has(body.kind)) return new Response('no', { status });
      posted.push(body.kind);
      return new Response('ok', { status: 200 });
    };
    return { journal, posted, fetch };
  }

  it('an alert the endpoint refuses for good does not hold back the ones behind it', async () => {
    const r = refusing(new Set(['mirror_lag']));
    const a = new Alerter({ service: 'keeper', url: 'http://alerts.invalid/hook', append: (x) => r.journal.push(x), fetch: r.fetch });
    a.raise({ kind: 'mirror_lag', hint: 'x'.repeat(10) });
    a.raise({ kind: 'settle_failed', claimId: CLAIM });
    a.raise({ kind: 'expire_failed', claimId: CLAIM });
    expect(await a.flush()).toEqual({ sent: 2, failed: 1, dropped: 1 });
    expect(r.posted).toEqual(['settle_failed', 'expire_failed']);
    expect(a.pending()).toEqual([]);
    const drop = r.journal.find((x) => x.t === 'alertSent' && x.dropped !== undefined)!;
    expect(String(drop.dropped)).toContain('HTTP 400');
    // A restart does not bring the dropped one back.
    const again = new Alerter({ service: 'keeper', url: 'http://alerts.invalid/hook', append: (x) => r.journal.push(x), fetch: r.fetch });
    again.load(r.journal);
    expect(again.pending()).toEqual([]);
  });

  it('keeps everything queued while the endpoint refuses every alert (a wrong URL), and stops at a 5xx', async () => {
    const all = refusing(new Set(['mirror_lag', 'settle_failed']), 404);
    const a = new Alerter({ service: 'keeper', url: 'http://alerts.invalid/hook', append: (x) => all.journal.push(x), fetch: all.fetch });
    a.raise({ kind: 'mirror_lag' });
    a.raise({ kind: 'settle_failed', claimId: CLAIM });
    expect(await a.flush()).toEqual({ sent: 0, failed: 2 });
    expect(a.pending().map((x) => x.kind)).toEqual(['mirror_lag', 'settle_failed']);

    const down = refusing(new Set(['mirror_lag']), 503);
    const b = new Alerter({ service: 'keeper', url: 'http://alerts.invalid/hook', append: (x) => down.journal.push(x), fetch: down.fetch });
    b.raise({ kind: 'mirror_lag' });
    b.raise({ kind: 'settle_failed', claimId: CLAIM });
    expect(await b.flush()).toEqual({ sent: 0, failed: 1 });
    expect(down.posted).toEqual([]);
    expect(b.pending().map((x) => x.kind)).toEqual(['mirror_lag', 'settle_failed']);
  });
});
