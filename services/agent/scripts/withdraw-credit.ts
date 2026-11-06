// A party withdraws its whole credit from DepositVault (refunds and payouts to the shop; the
// deposit moved to credit by the platform's exit) through the status API's
// POST /v1/actions/withdrawCredit, as the web app does. Dry run by default: reads the party's credit
// from /v1/parties/{address}, has the API check and simulate the withdrawal as the side's account,
// checks the answer is exactly DepositVault.withdrawCredit() on this checkout's vault, and prints
// the preview; nothing is signed. `--send` signs from the side's keystore (PLATFORM_KEY_FILE or
// SHOP_KEY_FILE), sends it through HEDERA_RPC_URL_1 and reads the credit back through the API.
//
//   pnpm --filter @recourse/agent withdraw-credit --as platform|shop [--send] [--wait <s>]
//
// The status API is STATUS_API_URL (default http://127.0.0.1:8787) and must serve the contracts in
// deployments/hedera.json (or the *.local.json HEDERA_LOCAL_FILE names). An account with no credit
// is refused (no_credit). On Circle's USDC the transfer needs the account associated with the
// token (not_associated); the testnet mock needs none.
//
// Exit codes: 0 done (or dry run passed), 2 refused, 1 error.

import { parseArgs } from 'node:util';
import { exitFor, openHedera, runAction, sideSigner, waitMs } from '../src/act.js';
import { stateLines, type PartyRead } from '../src/status-api.js';
import type { PartySide } from '../../shop/src/claim-actions.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      as: { type: 'string' },
      send: { type: 'boolean', default: false },
      wait: { type: 'string' },
    },
  });
  if (values.as !== 'platform' && values.as !== 'shop') throw new Error('--as platform|shop is required');
  const side: PartySide = values.as;
  const readBackTimeoutMs = waitMs(values.wait);

  const env = process.env;
  const h = await openHedera(env, sideSigner(env, side));
  const me = h.account.address;
  const { deployment } = h;
  console.log(`status API ${h.client.base}; deployment ${deployment.file} (chain ${deployment.chainId}), vault ${deployment.vault}, token ${deployment.token.label}`);
  console.log(`withdrawing as the ${side}: ${me}`);
  const before = await h.client.get<PartyRead>(`/v1/parties/${me}`);
  for (const line of stateLines(before)) console.log(`before: ${line}`);

  const r = await runAction({
    tool: 'withdraw-credit',
    client: h.client,
    action: 'withdrawCredit',
    body: { from: me },
    account: h.account,
    chainId: deployment.chainId,
    claimId: null,
    calls: () => [{ contract: 'DepositVault', to: deployment.vault, abi: h.vaultAbi, functionName: 'withdrawCredit', args: [] }],
    send: values.send ?? false,
    rpc: h.rpc,
    readBackTimeoutMs,
  });
  return r.code;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => process.exit(exitFor('withdraw-credit', error)),
);
