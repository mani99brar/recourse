// Whether a platform is in good standing with the deposit vault, read before a paid order is
// accepted when the standing check is on. An unreadable answer is never taken as good.

import type { Address } from 'viem';
import { loadAbi, publicClientFor, readHederaDeployment } from './chain.js';

export interface StandingReader {
  inGoodStanding(platform: Address): Promise<boolean>;
}

type Env = Record<string, string | undefined>;

/** Reads `inGoodStanding` on the vault named in the deployment file, through HEDERA_RPC_URL_1. */
export function vaultStandingReader(env: Env = process.env): StandingReader {
  return {
    async inGoodStanding(platform: Address): Promise<boolean> {
      const deployment = readHederaDeployment({ env });
      const rpcUrl = env.HEDERA_RPC_URL_1;
      if (!rpcUrl) throw new Error('HEDERA_RPC_URL_1 is not set');
      const ok = await publicClientFor(rpcUrl, deployment.chainId).readContract({
        address: deployment.vault,
        abi: loadAbi('DepositVault', env),
        functionName: 'inGoodStanding',
        args: [platform],
      });
      return ok === true;
    },
  };
}
