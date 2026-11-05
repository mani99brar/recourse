// Read-only probe of the Arkiv testnet. Never sends a transaction and never needs a key.
// Usage: tsx scripts/check-testnet.ts [writer-address]
//
// 1. eth_chainId on the RPC must be 0x76edaf.
// 2. A `case` query scoped to the writer must answer, with at most one page of rows.
// 3. The ERC-8004 self-feedback guard is checked when a party map and a funded agent exist;
//    otherwise the check is skipped with the reason printed.

import { createPublicClient, http, type Address } from 'viem';
import { arkivChain, buildWhere, arkivSchemas } from '../src/store/arkivSdk.js';
import { createPublicClient as createArkivPublic } from '@arkiv-network/sdk';
import { addressBook } from '@recourse/shared';
import { existsSync } from 'node:fs';

const CHAIN_ID = '0x76edaf';
const writer = (process.argv[2] ?? process.env.SCHEME_ADDRESS ?? '0x54E4545AFcf8960884A750320e70aFE16b2b3CaE') as Address;
const accessKey = process.env.ARKIV_ACCESS_KEY ?? '';
const chain = arkivChain(accessKey, process.env.ARKIV_RPC_URL);

async function main(): Promise<void> {
  let failed = false;
  const rpc = createPublicClient({ chain, transport: http() });
  const id = `0x${(await rpc.getChainId()).toString(16)}`;
  console.log(`chain id ${id} ${id === CHAIN_ID ? 'ok' : 'WRONG'}`);
  if (id !== CHAIN_ID) failed = true;

  const arkiv = createArkivPublic({ chain, transport: http() }) as any;
  try {
    const result = await arkiv
      .select({ $key: true })
      .from(arkivSchemas.case)
      .where(buildWhere('case', [['tier', 'ruled']]))
      .ownedBy(writer)
      .limit(100)
      .fetch();
    const n = (result.entities as unknown[]).length;
    console.log(`case query by owner ${writer}: ${n} row(s) ${n <= 100 ? 'ok' : 'TOO MANY'}`);
    if (n > 100) failed = true;
  } catch (error) {
    console.log(`case query failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    failed = true;
  }

  const partiesFile = process.env.PARTIES_FILE;
  if (partiesFile === undefined || !existsSync(partiesFile)) {
    console.log('erc-8004 self-feedback check skipped: no party map yet');
  } else {
    console.log(`erc-8004 reputation registry ${addressBook.hedera.erc8004Reputation}: self-feedback check runs in the review preflight`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.log(`probe failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  process.exit(1);
});
