// Fallback for 04-associate-usdc.sh: associate USDC (0.0.429274) with one role through a native
// TokenAssociate transaction signed by that role's own key. Untested: it needs the workspace
// install (@hiero-ledger/sdk) and a funded, complete account.
//
//   node ops/fund/associate-usdc.mjs <role>          (dry run: prints the plan)
//   node ops/fund/associate-usdc.mjs <role> --send
//
// The key is read through the shared loader, never from argv or the environment.
import { Client, AccountId, PrivateKey, TokenAssociateTransaction } from '@hiero-ledger/sdk';
import { loadKeyBytes } from '@recourse/shared/node';

const role = process.argv[2];
const send = process.argv.includes('--send');
if (!role) throw new Error('usage: associate-usdc.mjs <role> [--send]');

const ids = Object.fromEntries(
  (process.env.HEDERA_ACCOUNT_IDS ?? '').split(',').filter(Boolean).map((p) => p.split('=')),
);
const accountId = ids[role];
if (!accountId) throw new Error(`HEDERA_ACCOUNT_IDS has no entry for ${role}`);

console.log(`${role} (${accountId}) will associate with 0.0.429274`);
if (!send) process.exit(0);

// loadKeyBytes(envName) reads the *_KEY_FILE keystore named by that variable and its .pass file.
const envName = `${role.toUpperCase().replace(/-/g, '_')}_KEY_FILE`;
const key = PrivateKey.fromBytesECDSA(await loadKeyBytes(envName));
const client = Client.forTestnet().setOperator(AccountId.fromString(accountId), key);
const response = await new TokenAssociateTransaction()
  .setAccountId(accountId)
  .setTokenIds(['0.0.429274'])
  .freezeWith(client)
  .sign(key)
  .then((tx) => tx.execute(client));
const receipt = await response.getReceipt(client);
console.log(`status ${receipt.status.toString()} tx ${response.transactionId.toString()}`);
client.close();
