// The side a claim's pre-check went against contests it, inside the contest window, through the
// status API's POST /v1/actions/contest, as the web app does. Dry run by default: reads the claim
// from /v1/claims/{claimId}, has the API check and simulate the call as the side's account, checks
// the answer is exactly RecourseClaims.contest(claimId) on this checkout's claims contract, and
// prints the preview; nothing is signed. `--send` signs from the side's keystore (PLATFORM_KEY_FILE
// or SHOP_KEY_FILE), sends it through HEDERA_RPC_URL_1 and reads the claim back through the API.
//
//   pnpm --filter @recourse/agent contest --claim <claimId> --as platform|shop [--send] [--wait <s>]
//   pnpm --filter @recourse/agent contest --order <orderId> --as platform|shop [--send] [--wait <s>]
//
// Contesting moves no USDC: the court fee was escrowed from the shop when the claim was filed, so
// there is nothing to approve. The status API is STATUS_API_URL (default http://127.0.0.1:8787) and
// must serve the contracts in deployments/hedera.json (or the *.local.json HEDERA_LOCAL_FILE names).
// The API refuses with a typed error what the contract would refuse: not_contester (the other side,
// or another key), wrong_status, window_closed.
//
// Exit codes: 0 done (or dry run passed), 2 refused, 1 error.

import { parseArgs } from 'node:util';
import { isHex, type Hex } from 'viem';
import { claimIdOf } from '@recourse/shared';
import { claimsCall, exitFor, openHedera, runAction, sideSigner, waitMs } from '../src/act.js';
import { V1Failure, stateLines, type ClaimRead } from '../src/status-api.js';
import type { PartySide } from '../../shop/src/claim-actions.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      claim: { type: 'string' },
      order: { type: 'string' },
      as: { type: 'string' },
      send: { type: 'boolean', default: false },
      wait: { type: 'string' },
    },
  });
  if (!!values.claim === !!values.order) throw new Error('give exactly one of --claim <claimId> or --order <orderId>');
  if (values.as !== 'platform' && values.as !== 'shop') throw new Error('--as platform|shop is required');
  const side: PartySide = values.as;
  const id = (values.claim ?? values.order) as string;
  if (!isHex(id) || id.length !== 66) throw new Error(`${values.claim ? '--claim' : '--order'} must be a 32-byte hex id`);
  const readBackTimeoutMs = waitMs(values.wait);

  const env = process.env;
  const h = await openHedera(env, sideSigner(env, side));
  const { deployment } = h;
  const claimId = (values.claim ? id.toLowerCase() : claimIdOf(BigInt(deployment.chainId), deployment.claims, id as Hex)) as Hex;
  console.log(`status API ${h.client.base}; deployment ${deployment.file} (chain ${deployment.chainId}), claims ${deployment.claims}`);
  console.log(`contesting as the ${side}: ${h.account.address}`);
  try {
    const before = await h.client.get<ClaimRead>(`/v1/claims/${claimId}`);
    for (const line of stateLines(before)) console.log(`before: ${line}`);
  } catch (error) {
    if (!(error instanceof V1Failure) || error.code !== 'not_found') throw error;
    console.log(`before: the status API has not indexed claim ${claimId}; the action reads the chain itself`);
  }
  console.log('contesting moves no USDC (the fee is already in escrow), so there is nothing to approve');

  const r = await runAction({
    tool: 'contest',
    client: h.client,
    action: 'contest',
    body: { from: h.account.address, claimId },
    account: h.account,
    chainId: deployment.chainId,
    claimId,
    calls: () => [claimsCall(h, 'contest', claimId)],
    send: values.send ?? false,
    rpc: h.rpc,
    readBackTimeoutMs,
  });
  return r.code;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => process.exit(exitFor('contest', error)),
);
