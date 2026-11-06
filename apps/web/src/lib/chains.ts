// The two test networks the wallet acts on, and their explorers. Nothing here touches the browser.
import { arbitrumSepolia, hederaTestnet } from 'viem/chains';
import { formatUnits, type Chain } from 'viem';

/** Hedera testnet (296: hashio RPC, HBAR with 18 decimals in the EVM) and Arbitrum Sepolia (421614). */
export const CHAINS: Readonly<Record<number, Chain>> = Object.freeze({
  [hederaTestnet.id]: hederaTestnet,
  [arbitrumSepolia.id]: arbitrumSepolia,
});

export const HEDERA_CHAIN_ID = hederaTestnet.id;
export const ARBITRUM_CHAIN_ID = arbitrumSepolia.id;

/** True only for the two test networks: anything else is never signed for. */
export function isOurChain(id: number | null | undefined): id is 296 | 421614 {
  return id === HEDERA_CHAIN_ID || id === ARBITRUM_CHAIN_ID;
}

export function chainName(id: number | null | undefined): string {
  if (id === HEDERA_CHAIN_ID) return 'Hedera testnet';
  if (id === ARBITRUM_CHAIN_ID) return 'Arbitrum Sepolia';
  return id === null || id === undefined ? 'no network' : `network ${id}`;
}

/** "Hedera testnet (chain 296)": the network named with its id, as a wallet shows it. */
export function chainLabel(id: number): string {
  return `${chainName(id)} (chain ${id})`;
}

/** HashScan testnet for 296, Arbiscan Sepolia for 421614 (the forms the status API links to). */
export function txLink(chainId: number, hash: string): string | null {
  if (chainId === HEDERA_CHAIN_ID) return `https://hashscan.io/testnet/transaction/${hash}`;
  if (chainId === ARBITRUM_CHAIN_ID) return `https://sepolia.arbiscan.io/tx/${hash}`;
  return null;
}

export function addressLink(chainId: number, address: string): string | null {
  if (chainId === HEDERA_CHAIN_ID) return `https://hashscan.io/testnet/account/${address}`;
  if (chainId === ARBITRUM_CHAIN_ID) return `https://sepolia.arbiscan.io/address/${address}`;
  return null;
}

export function explorerName(chainId: number): string {
  return chainId === HEDERA_CHAIN_ID ? 'HashScan' : chainId === ARBITRUM_CHAIN_ID ? 'Arbiscan' : 'explorer';
}

/** An amount in a token's smallest unit, exact, with its symbol: "0.36068 HBAR", "0.000041 ETH". */
export function units(amount: string | bigint, decimals: number, symbol: string): string {
  return `${formatUnits(BigInt(amount), decimals)} ${symbol}`;
}
