// TEST ONLY: builders for chain events and a docket wired to in-memory fakes.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, memoryLogger, readJournal } from '@recourse/records';
import type { Hex } from 'viem';
import { Docket, type DocketDeps, type JournalRow, type ReviewPort } from '../src/docket.js';
import type { DocketEvent } from '../src/events.js';
import { ArkivStore } from '../src/store/arkiv.js';
import type { DocketStore } from '../src/store/types.js';
import { MemoryArkivIo } from './fakes.js';

export const PLATFORM = '0xff845c7d57eb58f30dEEE83a96010FeE055FdaF6';
export const SHOP = '0x0d87ED2F5D792561B53043Ff028956125c820287';
export const NOV = Date.UTC(2026, 10, 5, 12) / 1000;

export function cid(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

let tx = 0;
function meta(ts: number) {
  tx += 1;
  return { chain: 'hedera' as const, tx: `0x${tx.toString(16).padStart(64, '0')}`, index: 0, ts };
}

export const E = {
  filed: (n: number, over: { platform?: string; shop?: string; filedAt?: number } = {}): DocketEvent => ({
    ...meta(over.filedAt ?? NOV), name: 'ClaimFiled', claimId: cid(n), shop: over.shop ?? SHOP, platform: over.platform ?? PLATFORM, filedAt: over.filedAt ?? NOV,
  }),
  precheck: (n: number, gap: number, answer: number, ts = NOV + 60): DocketEvent => ({ ...meta(ts), name: 'PreCheckRecorded', claimId: cid(n), gap, answer }),
  uncontested: (n: number, ts = NOV + 3600): DocketEvent => ({ ...meta(ts), name: 'ClosedUncontested', claimId: cid(n) }),
  expired: (n: number, ts = NOV + 3600): DocketEvent => ({ ...meta(ts), name: 'ClaimExpired', claimId: cid(n) }),
  undrawn: (n: number, ts = NOV + 3600): DocketEvent => ({ ...meta(ts), name: 'ClosedUndrawn', claimId: cid(n) }),
  ruling: (n: number, ruling: number, attempts = 1, ts = NOV + 7200, disputeId = String(100 + n)): DocketEvent => ({
    ...meta(ts), name: 'RulingReceived', claimId: cid(n), disputeId, ruling, attempts,
  }),
  settled: (n: number, ts = NOV + 9000): DocketEvent => ({ ...meta(ts), name: 'Settled', claimId: cid(n) }),
  applied: (n: number, paid: string, refund = '0', ts = NOV + 9000): DocketEvent => ({ ...meta(ts), name: 'OutcomeApplied', claimId: cid(n), paid, refund, toPool: '0' }),
};

export interface Rig {
  docket: Docket;
  io: MemoryArkivIo;
  store: DocketStore;
  journalPath: string;
  clock: { t: number };
  alerts: string[];
  journal: Journal<JournalRow>;
  reopen(overrides?: Partial<DocketDeps>): Docket;
}

export function rig(overrides: Partial<DocketDeps> = {}, shared?: { io?: MemoryArkivIo; dir?: string }): Rig {
  const dir = shared?.dir ?? mkdtempSync(join(tmpdir(), 'docket-'));
  const journalPath = join(dir, 'docket.jsonl');
  const io = shared?.io ?? new MemoryArkivIo();
  const clock = { t: NOV + 100_000 };
  const alerts: string[] = [];
  const store = new ArkivStore(io);
  const open = (extra: Partial<DocketDeps> = {}) => {
    const history = readJournal<JournalRow>(journalPath).rows;
    const journal = Journal.open<JournalRow>(journalPath);
    const docket = new Docket({
      store, journal, history, now: () => clock.t, log: memoryLogger(), alert: (t) => void alerts.push(t), retrySeconds: 600, retryMax: 3, ...overrides, ...extra,
    });
    return { docket, journal };
  };
  const first = open();
  return {
    docket: first.docket, io, store, journalPath, clock, alerts, journal: first.journal,
    reopen: (extra) => {
      first.journal.close();
      return open(extra).docket;
    },
  };
}

export const noReviews: ReviewPort = { process: async () => {}, statusOf: () => ({ platform: { status: 'none' }, shop: { status: 'none' } }) };
