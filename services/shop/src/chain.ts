// The shop's view of the Hedera contracts: addresses from the deployment file, ABIs from
// `deployments/abi/`, and viem clients on the configured JSON-RPC relay (or a local anvil).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
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
import { HEDERA_TESTNET_CHAIN_ID, vaultTokenOf, type VaultToken } from '@recourse/shared';

type Env = Record<string, string | undefined>;

const REPO_DEPLOYMENTS = fileURLToPath(new URL('../../../deployments/', import.meta.url));

export function deploymentsDir(env: Env = process.env): string {
  return env.DEPLOYMENTS_DIR || REPO_DEPLOYMENTS;
}

export interface HederaDeployment {
  chainId: number;
  claims: Address;
  vault: Address;
  /** The vault's token, from the record's `usdc` object (none: Circle USDC). */
  token: VaultToken;
  /** The address every vault-side USDC read and approve uses: the token's, or a local file's `local.usdc`. */
  usdc: Address;
  /** Present in a local file only: the anvil accounts that play each role. */
  roles: { platform?: Address; shop?: Address } | null;
  file: string;
}

/** The deployment file is not there yet: as for a record with no `usdc` object, its vault token is Circle's. */
export class DeploymentMissingError extends Error {
  constructor(readonly file: string) {
    super(`deployment: ${file} does not exist yet`);
    this.name = 'DeploymentMissingError';
  }
}

/**
 * Reads `hedera.json` from the deployments directory, or the `*.local.json` written for anvil that
 * `file` or HEDERA_LOCAL_FILE names (a bare file name). A file that is not there yet throws
 * DeploymentMissingError; a bad one, a plain Error.
 */
export function readHederaDeployment(options: { env?: Env; file?: string } = {}): HederaDeployment {
  const name = options.file ?? (options.env ?? process.env).HEDERA_LOCAL_FILE ?? 'hedera.json';
  if (name !== 'hedera.json' && !/^[A-Za-z0-9_.-]+\.local\.json$/.test(name)) {
    throw new Error(`deployment: ${name} must be hedera.json or a bare *.local.json name`);
  }
  const file = join(deploymentsDir(options.env), name);
  if (!existsSync(file)) throw new DeploymentMissingError(file);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    chainId: number;
    contracts: { claims: { address: string }; vault: { address: string } };
    roles?: { platform?: string; shop?: string } | null;
    local?: { usdc?: string } | null;
    usdc?: unknown;
  };
  const isLocal = file.endsWith('.local.json');
  if (!isLocal && raw.chainId !== HEDERA_TESTNET_CHAIN_ID) throw new Error(`deployment: ${file} is not for Hedera testnet`);
  const token = vaultTokenOf(raw);
  // A local file's mock sits at `local.usdc`; a record that also names a token must name the same one.
  const localUsdc = isLocal && raw.local?.usdc ? getAddress(raw.local.usdc) : null;
  if (localUsdc && raw.usdc !== undefined && localUsdc !== token.address) {
    throw new Error(`deployment: ${file} has local.usdc ${localUsdc} but usdc.address ${token.address}`);
  }
  return {
    chainId: raw.chainId,
    claims: getAddress(raw.contracts.claims.address),
    vault: getAddress(raw.contracts.vault.address),
    token,
    usdc: localUsdc ?? token.address,
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

/** `balanceOf(holder)` on an ERC-20 by eth_call: the account checks' reader for a token with no mirror rows. */
export function balanceReader(client: PublicClient): (token: Address, holder: Address) => Promise<bigint> {
  return (token, holder) => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
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
