// The shop's view of the Hedera contracts: addresses from the deployment file, ABIs from
// `deployments/abi/`, and viem clients on the configured JSON-RPC relay (or a local anvil).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
  type Chain,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { hederaTestnet } from 'viem/chains';
import { HEDERA_TESTNET_CHAIN_ID, addressBook } from '@recourse/shared';

type Env = Record<string, string | undefined>;

const REPO_DEPLOYMENTS = fileURLToPath(new URL('../../../deployments/', import.meta.url));

export function deploymentsDir(env: Env = process.env): string {
  return env.DEPLOYMENTS_DIR || REPO_DEPLOYMENTS;
}

export interface HederaDeployment {
  chainId: number;
  claims: Address;
  vault: Address;
  /** The USDC ERC-20 facade (the HTS token's EVM address, or the local mock). */
  usdc: Address;
  /** Present in a local file only: the anvil accounts that play each role. */
  roles: { platform?: Address; shop?: Address } | null;
  file: string;
}

/** Reads `hedera.json` (or a `*.local.json` written for anvil) from the deployments directory. */
export function readHederaDeployment(options: { env?: Env; file?: string } = {}): HederaDeployment {
  const file = join(deploymentsDir(options.env), options.file ?? 'hedera.json');
  if (!existsSync(file)) throw new Error(`deployment: ${file} does not exist yet`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    chainId: number;
    contracts: { claims: { address: string }; vault: { address: string } };
    roles?: { platform?: string; shop?: string } | null;
    local?: { usdc?: string } | null;
  };
  const isLocal = file.endsWith('.local.json');
  if (!isLocal && raw.chainId !== HEDERA_TESTNET_CHAIN_ID) throw new Error(`deployment: ${file} is not for Hedera testnet`);
  return {
    chainId: raw.chainId,
    claims: getAddress(raw.contracts.claims.address),
    vault: getAddress(raw.contracts.vault.address),
    usdc: getAddress(raw.local?.usdc ?? addressBook.hedera.usdc.facade),
    roles:
      isLocal && raw.roles
        ? {
            ...(raw.roles.platform ? { platform: getAddress(raw.roles.platform) } : {}),
            ...(raw.roles.shop ? { shop: getAddress(raw.roles.shop) } : {}),
          }
        : null,
    file,
  };
}

/** An ABI array from `deployments/abi/<name>.json`. */
export function loadAbi(name: 'RecourseClaims' | 'DepositVault', env: Env = process.env): Abi {
  const file = join(deploymentsDir(env), 'abi', `${name}.json`);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Abi | { abi: Abi };
  return Array.isArray(parsed) ? (parsed as Abi) : (parsed as { abi: Abi }).abi;
}

export interface ChainClients {
  chain: Chain;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: LocalAccount;
  /** Hedera's relay wants a legacy gas price and a margin on gas estimates; anvil needs neither. */
  hedera: boolean;
}

function chainFor(rpcUrl: string, chainId: number): Chain {
  if (chainId === HEDERA_TESTNET_CHAIN_ID) return hederaTestnet;
  return defineChain({
    id: chainId,
    name: `local-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** Read-only client; polls faster on a local chain. */
export function publicClientFor(rpcUrl: string, chainId: number): PublicClient {
  const pollingInterval = chainId === HEDERA_TESTNET_CHAIN_ID ? 2_000 : 200;
  return createPublicClient({
    chain: chainFor(rpcUrl, chainId),
    transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }),
    pollingInterval,
  }) as PublicClient;
}

export function chainClients(options: { rpcUrl: string; chainId: number; account: LocalAccount }): ChainClients {
  const hedera = options.chainId === HEDERA_TESTNET_CHAIN_ID;
  const chain = chainFor(options.rpcUrl, options.chainId);
  const pollingInterval = hedera ? 2_000 : 200;
  return {
    chain,
    publicClient: publicClientFor(options.rpcUrl, options.chainId),
    walletClient: createWalletClient({
      chain,
      transport: http(options.rpcUrl, { timeout: 30_000, retryCount: 2 }),
      account: options.account,
      pollingInterval,
    }),
    account: options.account,
    hedera,
  };
}
