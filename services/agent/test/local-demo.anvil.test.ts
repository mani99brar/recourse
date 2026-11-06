// The whole local order on a real local chain: checkout, packed, arrived and complaint on the
// simulated topic, then fileClaim on the locally deployed RecourseClaims. Slow (deploys once); run
// under the suite lock.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claimIdOf } from '@recourse/shared';
import { readParties } from '@recourse/shared/node';
import { memoryLogger } from '@recourse/records';
import { readHederaDeployment } from '../../shop/src/chain.js';
import { DEMO_AGENT_ACCOUNT, DEMO_SHOP_ACCOUNT, DEMO_TOPIC, runLocalDemo } from '../scripts/local-demo.js';

let close: (() => Promise<void>) | undefined;
afterAll(async () => {
  await close?.();
});

describe('local demo order', () => {
  it('runs from checkout to a filed claim and serves the topic and documents to other services', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'local-demo-'));
    const result = await runLocalDemo({ anvilPort: 8576, mirrorPort: 8577, shopPort: 8578, stateDir, log: memoryLogger() });
    close = result.close;

    expect(result.settlement).toMatch(/^fake-settlement:/);
    expect(result.records.map((r) => [r.kind, r.payer])).toEqual([
      ['asked', DEMO_AGENT_ACCOUNT],
      ['shown', DEMO_AGENT_ACCOUNT],
      ['approval', DEMO_AGENT_ACCOUNT],
      ['ordered', DEMO_AGENT_ACCOUNT],
      ['packed', DEMO_SHOP_ACCOUNT],
      ['arrived', DEMO_AGENT_ACCOUNT],
    ]);
    const deployment = readHederaDeployment({ file: result.env.HEDERA_LOCAL_FILE! });
    expect(result.claim.claimId).toBe(claimIdOf(31337n, deployment.claims, result.orderId));
    expect(result.claim.status).toBe(1);
    expect(result.claim.basketUsdc).toBe('1500000');
    expect(result.claim.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Another process reads the topic through the mirror port and documents through the gateway path.
    const mirror = result.env.HEDERA_MIRROR_URL!;
    const page = (await (await fetch(`${mirror}/api/v1/topics/${DEMO_TOPIC}/messages?sequencenumber=gte:1&order=asc&limit=100`)).json()) as {
      messages: { sequence_number: number; payer_account_id: string }[];
    };
    expect(page.messages.length).toBeGreaterThanOrEqual(6);
    const last = (await (await fetch(`${mirror}/api/v1/topics/${DEMO_TOPIC}/messages?order=desc&limit=1`)).json()) as {
      messages: { sequence_number: number }[];
    };
    expect(last.messages[0]!.sequence_number).toBe(page.messages.at(-1)!.sequence_number);
    const ordered = result.records.find((r) => r.kind === 'ordered')!;
    const doc = await (await fetch(`${result.env.IPFS_GATEWAY_URL}/ipfs/${ordered.cid}`)).json();
    expect(doc).toMatchObject({ kind: 'ordered', orderId: result.orderId, x402TxId: result.settlement });
    expect(readParties({ PARTIES_FILE: result.env.PARTIES_FILE }).map((p) => p.role)).toEqual(['platform', 'agent', 'shop', 'buyer']);
  }, 600_000);
});
