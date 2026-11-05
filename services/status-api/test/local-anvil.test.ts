// Runs against a real local Hedera-side stack (DeployLocal plus the money proofs) when
// LOCAL_ANVIL_URL and LOCAL_DEPLOYMENTS_FILE are set; skipped otherwise. The logs come from the
// anvil node through a mirror-shaped fake, so the real ABIs and the real event data are decoded.
import { PARAMS } from '@recourse/shared';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { loadDeployments } from '../src/deployments.js';
import { pollHedera } from '../src/sources/hedera.js';
import { Store } from '../src/store.js';
import type { SimLog } from './helpers/encode.js';
import { FakeMirror } from './helpers/mirror.js';
import { harness } from './helpers/service.js';
import { dirname, basename } from 'node:path';

const url = process.env.LOCAL_ANVIL_URL;
const file = process.env.LOCAL_DEPLOYMENTS_FILE;

describe.skipIf(!url || !file)('local Hedera stack', () => {
  it('indexes the money proofs: one settled claim, one closed uncontested, books balance', async () => {
    const dep = loadDeployments(dirname(file!));
    void basename;
    const c = createPublicClient({ transport: http(url!) });
    const m = new FakeMirror();
    m.pageSize = 7;
    let lastTs = 0n;
    for (const [address, contract] of [[dep.claims!, 'claims'], [dep.vault!, 'vault']] as const) {
      const rows = (await c.request({ method: 'eth_getLogs', params: [{ address, fromBlock: '0x0', toBlock: 'latest' }] })) as { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex; logIndex: Hex; blockNumber: Hex }[];
      const logs: SimLog[] = [];
      for (const r of rows) {
        const block = await c.getBlock({ blockNumber: BigInt(r.blockNumber) });
        const idx = Number(BigInt(r.logIndex));
        const ts = `${block.timestamp}.${String(Number(BigInt(r.blockNumber)) % 1000).padStart(3, '0')}${String(idx).padStart(6, '0')}`;
        if (block.timestamp > lastTs) lastTs = block.timestamp;
        logs.push({ chain: 'hedera', contract, ts, raw: { address, topics: r.topics, data: r.data, tx: r.transactionHash, logIndex: idx, time: block.timestamp, order: ts } });
      }
      m.addLogs(address, logs);
    }
    const store = new Store();
    await pollHedera(store, { fetch: m.fetch, baseUrl: 'http://mirror.test', timeoutMs: 1000, nowS: () => Number(lastTs) }, { claims: dep.claims!, vault: dep.vault! }, dep.hederaStart);
    expect(store.status.hedera.decodeFailures).toBe(0);
    const h = harness({ store, now: Number(lastTs) + 5, reader: null });
    const rows = await h.svc.claimRows();
    const keys = rows.map((r) => r.statusKey).sort();
    expect(keys).toContain('settled');
    expect(keys).toContain('closed_uncontested');
    for (const r of rows) {
      if (r.statusKey === 'settled' || r.statusKey === 'closed_uncontested') {
        expect(r.owed).toBe((r.paid ?? 0n) + (r.notCovered ?? 0n));
        expect(r.escrow.amount).toBe(BigInt(PARAMS.preLock.courtFeeUsdc)); // DeployLocal applies the preLock set
      }
    }
    const settled = rows.find((r) => r.statusKey === 'settled')!;
    expect(settled.escrow.fate).toBe('kept_by_pool');
    expect(rows.find((r) => r.statusKey === 'closed_uncontested')!.escrow.fate).toBe('refunded');
  });
});
