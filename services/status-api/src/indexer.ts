// Polling loop: reads every source in turn, refreshes live state, keeps the snapshot. One failing
// source never stops the others; each backs off on its own.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hcsWritersFor, type Parties } from '@recourse/shared';
import type { Config } from './config.js';
import type { Deployments } from './deployments.js';
import type { FetchLike } from './http.js';
import type { DocFetcher } from './ipfs.js';
import { refreshLive, type Reader } from './live.js';
import { pollArbitrum, pollEvidence, type ArbDeps, type ArbRpc } from './sources/arbitrum.js';
import { pollHcs } from './sources/hcs.js';
import { pollHedera, type MirrorDeps } from './sources/hedera.js';
import { Store } from './store.js';
import type { SourceName } from './types.js';

export interface IndexerDeps {
  store: Store;
  cfg: Config;
  deployments: Deployments;
  fetch: FetchLike;
  arbRpc: ArbRpc | null;
  reader: Reader | null;
  parties: () => Parties | null;
  docs: DocFetcher;
  nowS: () => number;
}

export class Indexer {
  private backoff: Record<SourceName, { ms: number; until: number }> = {
    hedera: { ms: 1000, until: 0 },
    arbitrum: { ms: 1000, until: 0 },
    hcs: { ms: 1000, until: 0 },
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(private d: IndexerDeps) {}

  private due(name: SourceName): boolean {
    return this.d.nowS() * 1000 >= this.backoff[name].until;
  }

  private settle(name: SourceName): void {
    const b = this.backoff[name];
    if (this.d.store.status[name].failing) {
      b.until = this.d.nowS() * 1000 + b.ms;
      b.ms = Math.min(b.ms * 2, 30_000);
    } else {
      b.ms = 1000;
      b.until = 0;
    }
  }

  async pollOnce(): Promise<void> {
    const { store, cfg, deployments: dep } = this.d;
    const mirror: MirrorDeps = { fetch: this.d.fetch, baseUrl: cfg.mirrorUrl, timeoutMs: cfg.sourceTimeoutMs, nowS: this.d.nowS };
    if ((dep.claims || dep.vault) && this.due('hedera')) {
      await pollHedera(store, mirror, { ...(dep.claims ? { claims: dep.claims } : {}), ...(dep.vault ? { vault: dep.vault } : {}) }, dep.hederaStart);
      this.settle('hedera');
    }
    if (cfg.recordsTopic !== '' && this.due('hcs')) {
      const isWriter = (kind: number, payer: string) => {
        const ps = this.d.parties();
        return ps ? hcsWritersFor(ps, kind).has(payer) : null;
      };
      await pollHcs(store, mirror, cfg.recordsTopic, { isWriter });
      this.settle('hcs');
    }
    if (dep.caseAddress && this.d.arbRpc && this.due('arbitrum')) {
      const arb: ArbDeps = { rpc: this.d.arbRpc, confirmations: cfg.arbConfirmations, chunk: cfg.arbLogChunk, nowS: this.d.nowS };
      await pollArbitrum(store, arb, dep.caseAddress, dep.arbitrumStartBlock);
      this.settle('arbitrum');
      if (!store.status.arbitrum.failing) await this.evidence(arb);
    }
    if (this.d.reader) await refreshLive(store, this.d.reader, this.d.nowS);
    await this.prefetchDocs();
    if (store.rebuilding && this.caughtUp()) store.rebuilding = false;
  }

  /**
   * A fresh store answers once the source that defines the claims has read through to its head:
   * Hedera when configured (else Arbitrum, else the topic). Waiting for every source made one
   * failing source, such as the records topic, hide all data indefinitely; the other sources'
   * lag shows in `degraded`, and records the topic has not been read to yet read as unknown.
   */
  private caughtUp(): boolean {
    const dep = this.d.deployments;
    const st = this.d.store.status;
    const lead: SourceName | null = dep.claims || dep.vault ? 'hedera' : dep.caseAddress ? 'arbitrum' : this.d.cfg.recordsTopic !== '' ? 'hcs' : null;
    return lead === null || (st[lead].indexedThrough !== null && !st[lead].failing);
  }

  private async evidence(arb: ArbDeps): Promise<void> {
    const { store, deployments: dep } = this.d;
    if (!dep.caseAddress) return;
    for (const id of store.claimIds()) {
      for (const e of store.eventsOf(id)) {
        if (e.name !== 'CaseOpened' || e.block === undefined) continue;
        const attempt = Number(e.args.attempt);
        if (attempt !== 1 && attempt !== 2) continue;
        try {
          await pollEvidence(store, arb, dep.outside.evidenceModule, dep.arbitrumChainId, dep.caseAddress, id as `0x${string}`, attempt, e.block);
        } catch {
          // evidence is shown when readable; the case itself does not depend on it
        }
      }
    }
  }

  private async prefetchDocs(): Promise<void> {
    const parties = this.d.parties();
    if (!parties) return;
    let budget = 20;
    for (const r of this.d.store.hcs.values()) {
      if (budget <= 0) break;
      if (this.d.docs.peek(r.cid, r.hash) !== undefined) continue;
      if (!hcsWritersFor(parties, r.kind).has(r.payer)) continue;
      budget--;
      await this.d.docs.get(r.cid, r.hash);
    }
  }

  // ------------------------------------------------------------------ snapshot

  snapshotPath(): string {
    return join(this.d.cfg.stateDir, 'snapshot.json');
  }

  saveSnapshot(): void {
    const dir = this.d.cfg.stateDir;
    if (dir === '') return;
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.snapshotPath()}.tmp`;
    writeFileSync(tmp, this.d.store.toJSON(), { mode: 0o600 });
    renameSync(tmp, this.snapshotPath());
  }

  /** Loads the snapshot into the store's place; returns the loaded store or null (rebuild). */
  static loadSnapshot(stateDir: string): Store | null {
    if (stateDir === '') return null;
    try {
      return Store.fromJSON(readFileSync(join(stateDir, 'snapshot.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      if (!this.running) {
        this.running = true;
        try {
          await this.pollOnce();
          this.saveSnapshot();
        } catch {
          // pollOnce records source errors itself; anything else is retried next tick
        } finally {
          this.running = false;
        }
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.d.cfg.pollMs);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
