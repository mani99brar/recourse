// The shop files its claim for an order through the status API's POST /v1/actions/fileClaim, as the
// web app does. Dry run by default: reads the shop's payment record and the records topic for what
// it files (the order nonce and platform, the refs, the basket it was paid), has the API build and
// simulate the call, checks the answer is exactly that fileClaim on this checkout's claims contract
// (after an approve of exactly the court fee to the vault on the deployment's token, when the
// allowance is short), and prints the preview; nothing is signed. `--send` signs each transaction
// from the shop's key, sends them in order through the RPC, each after the one before it has mined,
// and reads the claim back through the API, once (a rerun finds the claim filed and sends nothing).
//
//   pnpm --filter @recourse/shop file-claim --order <orderId> [--net-loss 1.50] [--send] [--state <dir>] [--unpacked] [--wait <s>]
//   pnpm --filter @recourse/shop file-claim --order <orderId> --local <name>.local.json --rpc http://127.0.0.1:<port> [--send]
//
// `--local` files on a local anvil deployment from anvil's development account 4 (the shop role
// there), and STATUS_API_URL must name a status API started with the same HEDERA_LOCAL_FILE;
// otherwise it files on the Hedera testnet deployment (deployments/hedera.json) from SHOP_KEY_FILE
// through HEDERA_RPC_URL_1. The status API is STATUS_API_URL (default http://127.0.0.1:8787).
//
// Before it builds, it waits (up to a minute) until GET /v1/orders/{orderId}/records shows every
// record the shop read: a record written moments before reaches the API's index on its next poll.
//
// A claim with no packed record from the shop on the topic is refused (no_packed_record): the fault
// rule would answer against the shop from step 6 on. `--unpacked` files it anyway, for an order whose
// platform is at fault in an earlier step.
//
// Exit codes: 0 done (or dry run passed, or already filed), 2 refused, 1 error.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { getAddress, parseUnits, type Hex, type LocalAccount } from 'viem';
import { HEDERA_TESTNET_CHAIN_ID, claimIdOf, partyByRole } from '@recourse/shared';
import { loadSigner, readParties } from '@recourse/shared/node';
import { Journal, TopicReader, fetchDocument, ipfsOptionsFromEnv, mirrorFromEnv, readJournal, recordsTopicId, withFileLock } from '@recourse/records';
import { Refused, courtFeeOf, exitFor, fileClaimRun, openHedera, waitMs } from '../../agent/src/act.js';
import { V1Failure, stateLines, type ClaimRead } from '../../agent/src/status-api.js';
import { assertShopJournal, shopStateDir } from '../src/boot.js';
import { readHederaDeployment } from '../src/chain.js';
import { ClaimInputError, claimInputFor } from '../src/claim-input.js';
import type { FilingJournalRow } from '../src/filing.js';
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
      unpacked: { type: 'boolean', default: false },
      wait: { type: 'string' },
    },
  });
  if (!values.order) throw new Error('--order is required');
  if (!!values.local !== !!values.rpc) throw new Error('--local and --rpc go together');
  const orderId = values.order as Hex;
  const readBackTimeoutMs = waitMs(values.wait);
  const stateDir = values.state ?? shopStateDir(process.env);
  assertShopJournal(stateDir);
  const env = { ...process.env, ...(values.local ? { HEDERA_LOCAL_FILE: values.local, HEDERA_RPC_URL_1: values.rpc } : {}) };

  const deployment = readHederaDeployment({ env });
  if (!values.local && deployment.chainId !== HEDERA_TESTNET_CHAIN_ID) throw new Error('not a Hedera testnet deployment');
  const parties = readParties(env);
  const shopParty = partyByRole(parties, 'shop', env);
  let account: LocalAccount;
  if (values.local) {
    account = devAccount(4);
    if (deployment.roles?.shop !== account.address) throw new Error('the local deployment shop is not anvil account 4');
  } else {
    account = loadSigner('SHOP_KEY_FILE', env);
  }
  if (getAddress(shopParty.evmAddress) !== account.address) throw new Error(`the shop key is ${account.address}, the party map's shop is ${shopParty.evmAddress}`);

  // What the shop files, from its own records: the API's answer must be exactly this.
  const rows = readJournal<ShopJournalRow>(join(stateDir, 'journal.jsonl')).rows;
  const reader = new TopicReader(mirrorFromEnv(env), recordsTopicId(env));
  const ipfs = ipfsOptionsFromEnv(env);
  let input: Awaited<ReturnType<typeof claimInputFor>>;
  try {
    input = await claimInputFor({
      rows,
      reader,
      parties,
      orderId,
      ...(values['net-loss'] ? { netLossUsdc: parseUnits(values['net-loss'], 6) } : {}),
      fetchDoc: (cid, hash) => fetchDocument(cid, hash, ipfs),
      allowUnpacked: values.unpacked ?? false,
    });
  } catch (error) {
    if (error instanceof ClaimInputError) throw new Refused([error.message]);
    throw error;
  }

  const h = await openHedera(env, account);
  const claimId = claimIdOf(BigInt(deployment.chainId), deployment.claims, input.orderId);
  const u = `µ${deployment.token.symbol}`;
  console.log(`status API ${h.client.base}; claim ${claimId} on ${deployment.claims} (chain ${deployment.chainId})`);
  console.log(`vault token ${deployment.token.label} at ${deployment.usdc}`);
  console.log(`order ${input.orderId}: nonce ${input.orderNonce}, platform ${input.platform}, settlement ${input.settlement}`);
  console.log(`basket ${input.basketUsdc} ${u}, net loss ${input.netLossUsdc} ${u}, court fee ${courtFeeOf(h.params)} ${u}`);
  console.log(`refs: topic ${input.refs.topicNum}, seq [${input.refs.seq.join(', ')}]`);

  const journalName = values.local ? `claims.${values.local.replace(/\.local\.json$/, '')}.jsonl` : 'claims.jsonl';
  return withFileLock(join(stateDir, `${journalName}.lock`), async () => {
    try {
      const filed = await h.client.get<ClaimRead>(`/v1/claims/${claimId}`);
      for (const line of stateLines(filed)) console.log(line);
      console.log('already filed; nothing to send');
      return 0;
    } catch (error) {
      if (!(error instanceof V1Failure) || error.code !== 'not_found') throw error;
    }
    const journal = Journal.open<FilingJournalRow>(join(stateDir, journalName));
    try {
      const r = await fileClaimRun(h, input, { send: values.send ?? false, journal, allowUnpacked: values.unpacked ?? false, readBackTimeoutMs });
      return r.code;
    } finally {
      journal.close();
    }
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => process.exit(exitFor('file-claim', error)),
);
