// A party withdraws its whole credit from DepositVault (refunds and payouts to the shop; the
// deposit moved to credit by the platform's exit). Dry run by default: reads the credit and the
// party's balance of the vault's token and simulates the withdrawal; nothing is signed. `--send` signs from the side's
// keystore (PLATFORM_KEY_FILE or SHOP_KEY_FILE) and withdraws.
//
//   pnpm --filter @recourse/agent withdraw-credit --as platform|shop [--send]
//
// Addresses come from deployments/hedera.json, or from the *.local.json that HEDERA_LOCAL_FILE
// names; the RPC is HEDERA_RPC_URL_1. The vault's token is the record's `usdc` (Circle USDC when it
// has none): on Circle's the transfer needs the account associated with it; the testnet mock needs none.
//
// Exit codes: 0 done (or dry run passed), 2 refused, 1 error.

import { parseArgs } from 'node:util';
import { erc20Abi, type Address } from 'viem';
import { HEDERA_TESTNET_CHAIN_ID } from '@recourse/shared';
import {
  CallRefused,
  openPartyChain,
  readCredit,
  sendCall,
  simulateCall,
  withdrawCreditCall,
  type PartySide,
} from '../../shop/src/claim-actions.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      as: { type: 'string' },
      send: { type: 'boolean', default: false },
    },
  });
  if (values.as !== 'platform' && values.as !== 'shop') throw new Error('--as platform|shop is required');
  const side: PartySide = values.as;

  const { deployment, contracts, clients } = await openPartyChain(process.env, side);
  const client = clients.publicClient;
  const me = clients.account.address;
  const u = `µ${deployment.token.symbol}`;
  console.log(`deployment ${deployment.file} (chain ${deployment.chainId}), vault ${deployment.vault}, token ${deployment.token.label} at ${deployment.usdc}`);
  console.log(`withdrawing as the ${side}: ${me}`);

  const read = async (who: Address) => {
    const [credit, usdc] = await Promise.all([
      readCredit(client, contracts, who),
      client.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    ]);
    return { credit, usdc };
  };
  const before = await read(me);
  console.log(`before: credit ${before.credit} ${u}, balance ${before.usdc} ${u}`);
  if (before.credit === 0n) {
    console.error('withdraw-credit: refused: this account has no credit in the deposit vault');
    return 2;
  }

  const call = withdrawCreditCall(contracts);
  let amount: bigint;
  try {
    amount = (await simulateCall(client, me, call)) as bigint;
  } catch (error) {
    if (error instanceof CallRefused) {
      console.error(`withdraw-credit: refused: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (!values.send) {
    console.log(`dry run: would withdraw ${amount} ${u}; nothing signed; rerun with --send`);
    return 0;
  }

  const receipt = await sendCall(clients, call);
  console.log(`withdrew in ${receipt.transactionHash} (block ${receipt.blockNumber})`);
  if (deployment.chainId === HEDERA_TESTNET_CHAIN_ID) console.log(`https://hashscan.io/testnet/transaction/${receipt.transactionHash}`);
  const after = await read(me);
  console.log(`after: credit ${after.credit} ${u}, balance ${after.usdc} ${u} (${after.usdc - before.usdc >= 0n ? '+' : ''}${after.usdc - before.usdc})`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`withdraw-credit: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
