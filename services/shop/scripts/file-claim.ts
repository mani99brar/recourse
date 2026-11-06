// The shop files its claim for an order on RecourseClaims. Dry run by default: reads the shop's
// payment record, the records topic and the chain, and prints the claim id, the refs, the basket,
// the court fee and the shop's balance of the vault's token (the deployment's USDC); nothing is signed. `--send` approves exactly the court fee and
// files, once (a rerun finds the claim and sends nothing).
//
//   pnpm --filter @recourse/shop file-claim --order <orderId> [--net-loss 1.50] [--send] [--state <dir>]
//   pnpm --filter @recourse/shop file-claim --order <orderId> --local <name>.local.json --rpc http://127.0.0.1:<port> [--send]
//
// `--local` files on a local anvil deployment from anvil's development account 4 (the shop role
// there); otherwise on the Hedera testnet deployment (deployments/hedera.json) from SHOP_KEY_FILE.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { erc20Abi, getAddress, parseUnits, type Hex, type LocalAccount } from 'viem';
import { HEDERA_TESTNET_CHAIN_ID, claimIdOf, partyByRole } from '@recourse/shared';
import { loadSigner, readParties } from '@recourse/shared/node';
import { Journal, TopicReader, createLogger, fetchDocument, ipfsOptionsFromEnv, mirrorFromEnv, readJournal, recordsTopicId, withFileLock } from '@recourse/records';
import { assertShopJournal, shopStateDir } from '../src/boot.js';
import { chainClients, loadAbi, readHederaDeployment } from '../src/chain.js';
import { claimInputFor } from '../src/claim-input.js';
import { ClaimFiler, type FilingJournalRow } from '../src/filing.js';
import { devAccount } from '../src/local-chain.js';
import type { ShopJournalRow } from '../src/orders.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      order: { type: 'string' },
      'net-loss': { type: 'string' },
      send: { type: 'boolean', default: false },
      state: { type: 'string' },
      local: { type: 'string' },
      rpc: { type: 'string' },
    },
  });
  if (!values.order) throw new Error('--order is required');
  if (!!values.local !== !!values.rpc) throw new Error('--local and --rpc go together');
  const orderId = values.order as Hex;
  const stateDir = values.state ?? shopStateDir(process.env);
  assertShopJournal(stateDir);
  const env = { ...process.env, ...(values.local ? { HEDERA_LOCAL_FILE: values.local, HEDERA_RPC_URL_1: values.rpc } : {}) };
  const log = createLogger('shop');

  const deployment = readHederaDeployment({ env });
  if (!values.local && deployment.chainId !== HEDERA_TESTNET_CHAIN_ID) throw new Error('not a Hedera testnet deployment');
  const rpcUrl = env.HEDERA_RPC_URL_1;
  if (!rpcUrl) throw new Error('HEDERA_RPC_URL_1 is not set');
  const parties = readParties(env);
  const shopParty = partyByRole(parties, 'shop');
  let account: LocalAccount;
  if (values.local) {
    account = devAccount(4);
    if (deployment.roles?.shop !== account.address) throw new Error('the local deployment shop is not anvil account 4');
  } else {
    account = loadSigner('SHOP_KEY_FILE', env);
  }
  if (getAddress(shopParty.evmAddress) !== account.address) throw new Error(`the shop key is ${account.address}, the party map's shop is ${shopParty.evmAddress}`);

  const rows = readJournal<ShopJournalRow>(join(stateDir, 'journal.jsonl')).rows;
  const reader = new TopicReader(mirrorFromEnv(env), recordsTopicId(env));
  const ipfs = ipfsOptionsFromEnv(env);
  const input = await claimInputFor({
    rows,
    reader,
    parties,
    orderId,
    ...(values['net-loss'] ? { netLossUsdc: parseUnits(values['net-loss'], 6) } : {}),
    fetchDoc: (cid, hash) => fetchDocument(cid, hash, ipfs),
  });
  const clients = chainClients({ rpcUrl, chainId: deployment.chainId, account });
  const journalName = values.local ? `claims.${values.local.replace(/\.local\.json$/, '')}.jsonl` : 'claims.jsonl';
  return withFileLock(join(stateDir, `${journalName}.lock`), async () => {
    const journal = Journal.open<FilingJournalRow>(join(stateDir, journalName));
    try {
      const filer = new ClaimFiler({
        clients,
        claims: deployment.claims,
        vault: deployment.vault,
        usdc: deployment.usdc,
        claimsAbi: loadAbi('RecourseClaims', env),
        vaultAbi: loadAbi('DepositVault', env),
        journal,
        log,
      });
      const claimId = claimIdOf(BigInt(deployment.chainId), deployment.claims, input.orderId);
      const [status, fee, balance] = await Promise.all([
        filer.statusOf(claimId),
        filer.courtFee(),
        clients.publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
      ]);
      const u = `µ${deployment.token.symbol}`;
      console.log(`claim ${claimId} on ${deployment.claims} (chain ${deployment.chainId}), status ${status}`);
      console.log(`vault token ${deployment.token.label} at ${deployment.usdc}`);
      console.log(`order ${input.orderId}: nonce ${input.orderNonce}, platform ${input.platform}, settlement ${input.settlement}`);
      console.log(`basket ${input.basketUsdc} ${u}, net loss ${input.netLossUsdc} ${u}, court fee ${fee} ${u}, shop holds ${balance} ${u}`);
      console.log(`refs: topic ${input.refs.topicNum}, seq [${input.refs.seq.join(', ')}]`);
      if (!values.send) {
        console.log(status === 0 ? 'dry run: nothing signed; rerun with --send' : 'already filed; nothing to send');
        return 0;
      }
      if (status === 0 && balance < fee) throw new Error(`the shop holds less ${deployment.token.symbol} than the court fee`);
      const filed = await filer.fileClaim(input);
      console.log(JSON.stringify(filed));
      if (deployment.chainId === HEDERA_TESTNET_CHAIN_ID && filed.txHash) console.log(`https://hashscan.io/testnet/transaction/${filed.txHash}`);
      return 0;
    } finally {
      journal.close();
    }
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`file-claim: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
