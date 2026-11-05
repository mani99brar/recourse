// Address book for the two chains this repo runs on. Only third-party contracts live here; the
// contracts this repo deploys are read from `$DEPLOYMENTS_DIR/*.json`.

import type { Address } from 'viem';

export const HEDERA_TESTNET_CHAIN_ID = 296;
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;

export interface HederaBook {
  chainId: 296;
  ccipSelector: bigint;
  router: Address;
  onRamp: Address;
  offRamp: Address;
  link: Address;
  usdc: { tokenId: string; facade: Address; decimals: 6 };
  hts: Address;
  prng: Address;
  erc8004Identity: Address;
  erc8004IdentityAccountId: string;
  erc8004Reputation: Address;
  erc8004ReputationAccountId: string;
  mirrorUrl: string;
}

export interface ArbitrumBook {
  chainId: 421614;
  ccipSelector: bigint;
  router: Address;
  onRamp: Address;
  offRamp: Address;
  link: Address;
  klerosCore: Address;
  disputeTemplateRegistry: Address;
  evidenceModule: Address;
  disputeResolver: Address;
  disputeKitClassic: Address;
  sortitionModule: Address;
  pnk: Address;
  pnkFaucet: Address;
}

export interface AddressBook {
  hedera: HederaBook;
  arbitrum: ArbitrumBook;
}

export const addressBook: AddressBook = {
  hedera: {
    chainId: 296,
    ccipSelector: 222782988166878823n,
    router: '0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4',
    // Lane ramps for Hedera <-> Arbitrum Sepolia: OnRamp sends to Arbitrum, OffRamp receives from it.
    onRamp: '0x023B31f937cFb8ce59A264C73D3D4CB345Fb3Aef',
    offRamp: '0x7752798D2fD9e28b7020135A619dDD162d705f20',
    link: '0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6',
    usdc: { tokenId: '0.0.429274', facade: '0x0000000000000000000000000000000000068cda', decimals: 6 },
    hts: '0x0000000000000000000000000000000000000167',
    prng: '0x0000000000000000000000000000000000000169',
    erc8004Identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    erc8004IdentityAccountId: '0.0.7919997',
    erc8004Reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    erc8004ReputationAccountId: '0.0.7919998',
    mirrorUrl: 'https://testnet.mirrornode.hedera.com/api/v1',
  },
  arbitrum: {
    chainId: 421614,
    ccipSelector: 3478487238524512106n,
    router: '0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165',
    // OnRamp sends to Hedera, OffRamp receives from it.
    onRamp: '0x6B9a7cF69F90Ae2659bfe3069fba5Aa308A48cC4',
    offRamp: '0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA',
    link: '0xb1D4538B4571d411F07960EF2838Ce337FE1E80E',
    klerosCore: '0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479',
    disputeTemplateRegistry: '0xe763d31Cb096B4bc7294012B78FC7F148324ebcb',
    evidenceModule: '0xA88A9a25cE7f1d8b3941dA3b322Ba91D009E1397',
    disputeResolver: '0xed31bEE8b1F7cE89E93033C0d3B2ccF4cEb27652',
    disputeKitClassic: '0x0c38f115D001d3b5bBec5e8D44f78C7B61A27D94',
    sortitionModule: '0xbAA5068F0bD1417046250A3eDe2B1F27e31383BD',
    pnk: '0x34B944D42cAcfC8266955D07A80181D2054aa225',
    pnkFaucet: '0x9f6ffc13B685A68ae359fCA128dfE776458Df464',
  },
};

/** CCIP chain selector for a chain id this repo uses. Throws for any other chain. */
export function chainSelectorOf(chainId: number): bigint {
  if (chainId === addressBook.hedera.chainId) return addressBook.hedera.ccipSelector;
  if (chainId === addressBook.arbitrum.chainId) return addressBook.arbitrum.ccipSelector;
  throw new Error(`chainSelectorOf: unknown chain id ${chainId}`);
}
