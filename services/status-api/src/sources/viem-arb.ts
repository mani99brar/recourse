import { createPublicClient, http, type Address, type Hex } from 'viem';
import type { ArbLogRow, ArbRpc } from './arbitrum.js';

/** ArbRpc over a viem public client. */
export function viemArbRpc(url: string, timeoutMs: number): ArbRpc {
  const c = createPublicClient({ transport: http(url, { timeout: timeoutMs }) });
  return {
    blockNumber: () => c.getBlockNumber(),
    blockTime: async (n) => (await c.getBlock({ blockNumber: n })).timestamp,
    finalizedBlock: async () => (await c.getBlock({ blockTag: 'finalized' })).number,
    logs: async (a: { address: Address; fromBlock: bigint; toBlock: bigint; topics?: (Hex | Hex[] | null)[] }) => {
      const rows = await c.request({
        method: 'eth_getLogs',
        params: [
          {
            address: a.address,
            fromBlock: `0x${a.fromBlock.toString(16)}`,
            toBlock: `0x${a.toBlock.toString(16)}`,
            ...(a.topics ? { topics: a.topics } : {}),
          },
        ],
      });
      return (rows as { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex; logIndex: Hex; blockNumber: Hex }[]).map(
        (r): ArbLogRow => ({
          address: r.address,
          topics: r.topics,
          data: r.data,
          transactionHash: r.transactionHash,
          logIndex: Number(BigInt(r.logIndex)),
          blockNumber: BigInt(r.blockNumber),
        }),
      );
    },
  };
}
