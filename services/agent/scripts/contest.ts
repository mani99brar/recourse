// The side a claim's pre-check went against contests it, inside the contest window. Dry run by
// default: reads the claim, the contest window and court fee from the contract, the fee escrow and
// the chain time, checks the caller is the losing side, and simulates the call; nothing is signed.
// `--send` signs from the side's keystore (PLATFORM_KEY_FILE or SHOP_KEY_FILE) and contests.
//
//   pnpm --filter @recourse/agent contest --claim <claimId> --as platform|shop [--send]
//   pnpm --filter @recourse/agent contest --order <orderId> --as platform|shop [--send]
//
// Contesting moves no USDC: the court fee was escrowed from the shop when the claim was filed, so
// there is nothing to approve. Addresses come from deployments/hedera.json, or from the
// *.local.json that HEDERA_LOCAL_FILE names; the RPC is HEDERA_RPC_URL_1.
//
// Exit codes: 0 done (or dry run passed), 2 refused, 1 error.

import { parseArgs } from 'node:util';
import { isHex, type Hex } from 'viem';
import { Answer, ClaimStatus, HEDERA_TESTNET_CHAIN_ID, claimIdOf } from '@recourse/shared';
import {
  CallRefused,
  chainTime,
  contestCall,
  contestClosesAt,
  contestRefusal,
  contestingSide,
  expiresAt,
  isoOf,
  openPartyChain,
  readClaim,
  readClaimParams,
  readEscrow,
  sendCall,
  simulateCall,
  type ClaimParams,
  type ClaimView,
  type EscrowView,
  type PartySide,
} from '../../shop/src/claim-actions.js';
import { statusName } from '../../shop/src/reverts.js';

const ANSWER_NAMES: Record<number, string> = {
  [Answer.Unknown]: 'Unknown',
  [Answer.Platform]: 'Platform',
  [Answer.Merchant]: 'Merchant',
  [Answer.Neither]: 'Neither',
};
const ESCROW_STATES = ['none', 'open', 'closed'];

function describe(label: string, claim: ClaimView, params: ClaimParams, escrow: EscrowView, now: bigint, u: string): string[] {
  const lines = [`${label}: claim ${claim.claimId}, status ${statusName(claim.status)}`];
  if (claim.status === ClaimStatus.None) return lines;
  lines.push(`  order ${claim.orderId}, shop ${claim.shop}, platform ${claim.platform}`);
  lines.push(`  basket ${claim.basketUsdc} ${u}, net loss ${claim.netLossUsdc} ${u}`);
  if (claim.preCheckedAt > 0n) {
    lines.push(
      `  pre-check ${isoOf(claim.preCheckedAt)}: answer ${ANSWER_NAMES[claim.answer] ?? claim.answer}, gap ${claim.gap}; losing side: ${contestingSide(claim.answer)}`,
    );
    if (claim.status === ClaimStatus.PreChecked) {
      const closesAt = contestClosesAt(claim, params);
      const left = closesAt - now;
      lines.push(
        `  contest window ${params.contestWindow} s, closes ${isoOf(closesAt)} (${left >= 0n ? `${left} s left` : 'closed'}; chain time ${isoOf(now)})`,
      );
    }
  }
  lines.push(
    `  court fee ${params.courtFeeUsdc} ${u}; escrow ${ESCROW_STATES[escrow.state] ?? escrow.state}, ${escrow.amount} ${u} from the shop, taken at filing`,
  );
  const expiry = expiresAt(claim, params);
  if (expiry !== null) {
    const from = claim.status === ClaimStatus.Filed ? 'filing' : 'the pre-check';
    lines.push(`  expires ${isoOf(expiry)} (${params.claimTimeout} s after ${from}) unless it moves on first`);
  } else if (claim.status === ClaimStatus.PreChecked) {
    lines.push('  no expiry while PreChecked: after the window, closeUncontested settles it');
  }
  if (claim.contestedBy !== '0x0000000000000000000000000000000000000000') lines.push(`  contested by ${claim.contestedBy}`);
  return lines;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      claim: { type: 'string' },
      order: { type: 'string' },
      as: { type: 'string' },
      send: { type: 'boolean', default: false },
    },
  });
  if (!!values.claim === !!values.order) throw new Error('give exactly one of --claim <claimId> or --order <orderId>');
  if (values.as !== 'platform' && values.as !== 'shop') throw new Error('--as platform|shop is required');
  const side: PartySide = values.as;
  const id = (values.claim ?? values.order) as string;
  if (!isHex(id) || id.length !== 66) throw new Error(`${values.claim ? '--claim' : '--order'} must be a 32-byte hex id`);

  const { deployment, contracts, clients } = await openPartyChain(process.env, side);
  const client = clients.publicClient;
  const claimId: Hex = values.claim ? (id as Hex) : claimIdOf(BigInt(deployment.chainId), deployment.claims, id as Hex);
  const u = `µ${deployment.token.symbol}`;
  console.log(`deployment ${deployment.file} (chain ${deployment.chainId}), claims ${deployment.claims}, vault ${deployment.vault}, token ${deployment.token.label}`);
  console.log(`contesting as the ${side}: ${clients.account.address}`);

  const params = await readClaimParams(client, contracts);
  const read = async () => {
    const [claim, escrow, now] = await Promise.all([readClaim(client, contracts, claimId), readEscrow(client, contracts, claimId), chainTime(client)]);
    return { claim, escrow, now };
  };
  const before = await read();
  for (const line of describe('before', before.claim, params, before.escrow, before.now, u)) console.log(line);
  console.log('  contesting moves no USDC (the fee is already in escrow), so there is nothing to approve');

  const refusal = contestRefusal({ ...before, params, side, caller: clients.account.address });
  if (refusal) {
    console.error(`contest: refused: ${refusal}`);
    return 2;
  }
  const call = contestCall(contracts, claimId);
  try {
    await simulateCall(client, clients.account.address, call);
  } catch (error) {
    if (error instanceof CallRefused) {
      console.error(`contest: refused: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (!values.send) {
    console.log('dry run: the contest would go through; nothing signed; rerun with --send');
    return 0;
  }

  const receipt = await sendCall(clients, call);
  console.log(`contested in ${receipt.transactionHash} (block ${receipt.blockNumber})`);
  if (deployment.chainId === HEDERA_TESTNET_CHAIN_ID) console.log(`https://hashscan.io/testnet/transaction/${receipt.transactionHash}`);
  const after = await read();
  for (const line of describe('after', after.claim, params, after.escrow, after.now, u)) console.log(line);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`contest: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
