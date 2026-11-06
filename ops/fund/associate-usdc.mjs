// Fallback for 04-associate-usdc.sh: associate USDC (0.0.429274) with one role through a native
// TokenAssociate transaction signed by that role's own key. Untested: it needs the workspace
// install (@hiero-ledger/sdk) and a funded, complete account.
//
//   node ops/fund/associate-usdc.mjs <role>          (dry run: prints the plan)
//   node ops/fund/associate-usdc.mjs <role> --send
//
// The key is read through the shared loader, never from argv or the environment. A deployment on the
// testnet mock (usdc.mode "mock" in deployments/$HEDERA_FILE, default hedera.json) has nothing to
// associate: the mock is a plain ERC-20, so this prints that and exits 0 before loading the SDK. The
// record is checked as vaultTokenOf (packages/shared) checks it; anything else stops here.
import { existsSync, readFileSync } from 'node:fs';

const FACADE = '0x0000000000000000000000000000000000068cda';
const recordFile = new URL(`../../deployments/${process.env.HEDERA_FILE || 'hedera.json'}`, import.meta.url);
const usdc = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')).usdc : undefined;
const address = typeof usdc?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(usdc.address) ? usdc.address.toLowerCase() : null;
const valid =
  usdc === undefined ||
  (typeof usdc === 'object' && usdc !== null && usdc.decimals === 6 && address !== null &&
    (usdc.mode === 'circle'
      ? address === FACADE && usdc.tokenId === '0.0.429274'
      : usdc.mode === 'mock' && usdc.tokenId === null && address !== FACADE && !/^0x0{40}$/.test(address)));
if (!valid) throw new Error(`deployment usdc: expected circle mode on 0.0.429274 or a mock of its own, got ${JSON.stringify(usdc)}`);
if (usdc?.mode === 'mock') {
  console.log(`the vault runs on mUSDC (testnet mock) at ${usdc.address}: a plain ERC-20, no association needed`);
  process.exit(0);
}
const { Client, AccountId, PrivateKey, TokenAssociateTransaction } = await import('@hiero-ledger/sdk');
const { loadKeyBytes } = await import('@recourse/shared/node');

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
