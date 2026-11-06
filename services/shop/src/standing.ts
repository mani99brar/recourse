// Whether a platform may buy, read from the deposit vault before a paid order is accepted when the
// standing check is on: `inGoodStanding` (deposit at its requirement, or inside the top-up window)
// and `exitRequestedAt` (non-zero once the platform asked to leave; `inGoodStanding` does not look
// at it, and a claim against a platform whose exit is due is refused). An unreadable answer is
// never taken as good.

import type { Address } from 'viem';
import { loadAbi, publicClientFor, readHederaDeployment } from './chain.js';

export interface StandingReader {
  inGoodStanding(platform: Address): Promise<boolean>;
  /** Unix seconds of the platform's exit request; 0 when it has made none. */
  exitRequestedAt(platform: Address): Promise<bigint>;
}

type Env = Record<string, string | undefined>;

/** Reads the vault named in the deployment file, through HEDERA_RPC_URL_1. */
export function vaultStandingReader(env: Env = process.env): StandingReader {
  const read = async (functionName: 'inGoodStanding' | 'exitRequestedAt', platform: Address): Promise<unknown> => {
    const deployment = readHederaDeployment({ env });
    const rpcUrl = env.HEDERA_RPC_URL_1;
    if (!rpcUrl) throw new Error('HEDERA_RPC_URL_1 is not set');
    return publicClientFor(rpcUrl, deployment.chainId).readContract({
      address: deployment.vault,
      abi: loadAbi('DepositVault', env),
      functionName,
      args: [platform],
    });
  };
  return {
    async inGoodStanding(platform) {
      return (await read('inGoodStanding', platform)) === true;
    },
    async exitRequestedAt(platform) {
      const at = await read('exitRequestedAt', platform);
      if (typeof at !== 'bigint') throw new Error('exitRequestedAt: not a number');
      return at;
    },
  };
}
