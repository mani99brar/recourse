import { memoryLogger } from '@recourse/records';
import { describe, expect, it } from 'vitest';
import { oneAtATime, pollSources, type Poller } from '../src/boot.js';
import { E, rig } from './helpers.js';

describe('docket source polls', () => {
  const answers = (name: string, cursor: string): Poller => ({ name, poll: async () => ({ events: [E.filed(1)], cursor }) });
  const fails = (name: string, message: string): Poller => ({ name, poll: async () => Promise.reject(new Error(message)) });

  it('a source that answers after one that failed keeps the pass failed', async () => {
    const r = rig();
    const log = memoryLogger();
    const failure = await pollSources([fails('hedera-claims', 'mirror 502'), answers('arbitrum-case', '42')], r.docket, log);
    expect(failure).toBe('mirror 502');
    expect(r.docket.cursor('arbitrum-case')).toBe('42');
    expect(log.lines.filter((l) => l.event === 'poll_failed').map((l) => l.fields.source)).toEqual(['hedera-claims']);
  });

  it('a pass where every source answers has no failure', async () => {
    const r = rig();
    expect(await pollSources([answers('hedera-claims', '7'), answers('arbitrum-case', '42')], r.docket, memoryLogger())).toBeNull();
  });
});

describe('docket passes', () => {
  it('a pass started while the last one is still running does nothing', async () => {
    let calls = 0;
    let release!: () => void;
    const tick = oneAtATime(async () => {
      calls += 1;
      await new Promise<void>((r) => (release = r));
    });
    const first = tick();
    await tick(); // returns at once: the first pass is still running
    expect(calls).toBe(1);
    release();
    await first;
    const third = tick();
    expect(calls).toBe(2);
    release();
    await third;
  });

  it('a pass that throws does not block the next one', async () => {
    let calls = 0;
    const tick = oneAtATime(async () => {
      calls += 1;
      throw new Error('boom');
    });
    await expect(tick()).rejects.toThrow('boom');
    await expect(tick()).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('two overlapping docket passes write a case once', async () => {
    const r = rig();
    r.docket.ingest([E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1)]);
    let release!: () => void;
    r.io.hold = new Promise<void>((done) => (release = done));
    const tick = oneAtATime(async () => void (await r.docket.flush()));
    const slow = tick(); // its case create waits on the node
    await new Promise((done) => setTimeout(done, 10));
    const overlap = tick();
    await new Promise((done) => setTimeout(done, 10));
    r.io.hold = null;
    release();
    await Promise.all([slow, overlap]);
    expect([...r.io.entities.values()].filter((e) => e.schema === 'case')).toHaveLength(1);
  });
});
