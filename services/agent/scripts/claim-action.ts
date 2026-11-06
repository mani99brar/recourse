// A claim's other steps through the status API, as the web app makes them: the calls anyone may
// make on Hedera (the keeper makes them on its own; these are for when it has not) and adding
// evidence to the claim's Kleros dispute on Arbitrum. Dry run by default: has the API check and
// simulate the call as the side's account, checks the answer is exactly the intended call on this
// checkout's contracts, and prints the preview; nothing is signed. `--send` signs from the side's
// keystore (PLATFORM_KEY_FILE or SHOP_KEY_FILE), sends through HEDERA_RPC_URL_1 (ARB_RPC_URL for
// evidence) and reads the claim back through the API.
//
//   pnpm --filter @recourse/agent claim-action closeUncontested|expireClaim|settle|sendToCourt|resend
//                                             --claim <claimId> --as platform|shop [--send] [--wait <s>]
//   pnpm --filter @recourse/agent claim-action submitEvidence --claim <claimId> --as platform|shop
//                                             --name <title> --description <text> [--file-uri /ipfs/<cid>]
//                                             [--attempt 1|2] [--send] [--wait <s>]
//
// `--order <orderId>` names the claim by its order instead. The court shows the signing account as
// the party that submitted evidence. The status API is STATUS_API_URL (default
// http://127.0.0.1:8787) and must serve the contracts in deployments/hedera.json and arbitrum.json
// (or the *.local.json files HEDERA_LOCAL_FILE and ARBITRUM_LOCAL_FILE name).
//
// Exit codes: 0 done (or dry run passed), 2 refused, 1 error.

import { parseArgs } from 'node:util';
import { isHex, type Abi, type Hex } from 'viem';
import { claimIdOf, evidenceModuleAbi, externalIdUint } from '@recourse/shared';
import { Refused, claimsCall, exitFor, openHedera, readArbitrumDeployment, rpcAt, runAction, sideSigner, waitMs } from '../src/act.js';
import { deploymentProblems, type ActionName, type BuiltAction, type IntendedCall } from '../src/status-api.js';
import type { PartySide } from '../../shop/src/claim-actions.js';

const CLAIM_CALLS = ['closeUncontested', 'expireClaim', 'settle', 'sendToCourt', 'resend'] as const;
type ClaimCall = (typeof CLAIM_CALLS)[number];

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      claim: { type: 'string' },
      order: { type: 'string' },
      as: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      'file-uri': { type: 'string' },
      attempt: { type: 'string' },
      send: { type: 'boolean', default: false },
      wait: { type: 'string' },
    },
    allowPositionals: true,
  });
  const action = positionals[0];
  const evidence = action === 'submitEvidence';
  if (positionals.length !== 1 || (!evidence && !(CLAIM_CALLS as readonly string[]).includes(action ?? ''))) {
    throw new Error(`usage: claim-action ${[...CLAIM_CALLS, 'submitEvidence'].join('|')} --claim <claimId> --as platform|shop [--send]`);
  }
  if (!!values.claim === !!values.order) throw new Error('give exactly one of --claim <claimId> or --order <orderId>');
  if (values.as !== 'platform' && values.as !== 'shop') throw new Error('--as platform|shop is required');
  const side: PartySide = values.as;
  const id = (values.claim ?? values.order) as string;
  if (!isHex(id) || id.length !== 66) throw new Error(`${values.claim ? '--claim' : '--order'} must be a 32-byte hex id`);
  if (!evidence && (values.name || values.description || values['file-uri'] || values.attempt)) throw new Error('--name, --description, --file-uri and --attempt go with submitEvidence only');
  if (evidence && (!values.name || !values.description)) throw new Error('submitEvidence needs --name and --description');
  const attempt = values.attempt === undefined ? undefined : Number(values.attempt);
  if (attempt !== undefined && attempt !== 1 && attempt !== 2) throw new Error('--attempt: 1 or 2');
  const readBackTimeoutMs = waitMs(values.wait);

  const env = process.env;
  const h = await openHedera(env, sideSigner(env, side));
  const { deployment } = h;
  const claimId = (values.claim ? id.toLowerCase() : claimIdOf(BigInt(deployment.chainId), deployment.claims, id as Hex)) as Hex;
  console.log(`status API ${h.client.base}; claim ${claimId}; signing as the ${side}: ${h.account.address}`);

  if (!evidence) {
    const fn = action as ClaimCall;
    const r = await runAction({
      tool: 'claim-action',
      client: h.client,
      action: fn,
      body: { from: h.account.address, claimId },
      account: h.account,
      chainId: deployment.chainId,
      claimId,
      calls: () => [claimsCall(h, fn, claimId)],
      send: values.send ?? false,
      rpc: h.rpc,
      readBackTimeoutMs,
    });
    return r.code;
  }

  const arb = readArbitrumDeployment(env);
  const problems = deploymentProblems(h.params, { chain: 'arbitrum', chainId: arb.chainId, recourseCase: arb.recourseCase, evidenceModule: arb.evidenceModule });
  if (problems.length > 0) throw new Refused([`the status API at ${h.client.base} is not on this checkout's Arbitrum contracts (${arb.file}):`, ...problems.map((p) => `  - ${p}`)]);
  const fileUri = values['file-uri'];
  // The evidence string exactly as the court reads it, and as the API builds it from the same fields.
  const text = JSON.stringify(fileUri !== undefined ? { name: values.name, description: values.description, fileURI: fileUri } : { name: values.name, description: values.description });
  const calls = (resp: BuiltAction): IntendedCall[] => {
    const built = resp.input.attempt;
    const n = attempt ?? (built === 1 || built === 2 ? built : 0);
    return [{ contract: 'EvidenceModule', to: arb.evidenceModule, abi: evidenceModuleAbi as unknown as Abi, functionName: 'submitEvidence', args: [externalIdUint(arb.chainId, arb.recourseCase, claimId, n), text] }];
  };
  const r = await runAction({
    tool: 'claim-action',
    client: h.client,
    action: 'submitEvidence' satisfies ActionName,
    body: {
      from: h.account.address,
      claimId,
      name: values.name,
      description: values.description,
      ...(fileUri !== undefined ? { fileURI: fileUri } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
    },
    account: h.account,
    chainId: arb.chainId,
    claimId,
    calls,
    send: values.send ?? false,
    rpc: async () => {
      const url = env.ARB_RPC_URL;
      if (!url) throw new Error('ARB_RPC_URL is not set');
      return rpcAt(url, arb.chainId);
    },
    readBackTimeoutMs,
  });
  return r.code;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => process.exit(exitFor('claim-action', error)),
);
