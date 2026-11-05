// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Third-party addresses on Hedera testnet (296) and Arbitrum Sepolia (421614). The
/// TypeScript address book holds the same values; a forge test checks they match.
library RecourseAddresses {
    // Hedera testnet
    uint256 internal constant HEDERA_CHAIN_ID = 296;
    uint64 internal constant HEDERA_SELECTOR = 222782988166878823;
    address internal constant HEDERA_ROUTER = 0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4;
    address internal constant HEDERA_ONRAMP = 0x023B31f937cFb8ce59A264C73D3D4CB345Fb3Aef;
    address internal constant HEDERA_OFFRAMP = 0x7752798D2fD9e28b7020135A619dDD162d705f20;
    address internal constant HEDERA_LINK = 0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6;
    /// @dev HTS token 0.0.429274 (USDC, 6 decimals) through its ERC-20 facade.
    address internal constant HEDERA_USDC = 0x0000000000000000000000000000000000068cDa;
    address internal constant HEDERA_HTS = address(0x167);
    address internal constant HEDERA_PRNG = address(0x169);
    address internal constant HEDERA_ERC8004_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant HEDERA_ERC8004_REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    // Arbitrum Sepolia
    uint256 internal constant ARBITRUM_CHAIN_ID = 421614;
    uint64 internal constant ARBITRUM_SELECTOR = 3478487238524512106;
    address internal constant ARBITRUM_ROUTER = 0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165;
    address internal constant ARBITRUM_ONRAMP = 0x6B9a7cF69F90Ae2659bfe3069fba5Aa308A48cC4;
    address internal constant ARBITRUM_OFFRAMP = 0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA;
    address internal constant ARBITRUM_LINK = 0xb1D4538B4571d411F07960EF2838Ce337FE1E80E;
    address internal constant KLEROS_CORE = 0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479;
    address internal constant DISPUTE_TEMPLATE_REGISTRY = 0xe763d31Cb096B4bc7294012B78FC7F148324ebcb;
    address internal constant EVIDENCE_MODULE = 0xA88A9a25cE7f1d8b3941dA3b322Ba91D009E1397;
    address internal constant DISPUTE_RESOLVER = 0xed31bEE8b1F7cE89E93033C0d3B2ccF4cEb27652;
    address internal constant DISPUTE_KIT_CLASSIC = 0x0c38f115D001d3b5bBec5e8D44f78C7B61A27D94;
    address internal constant SORTITION_MODULE = 0xbAA5068F0bD1417046250A3eDe2B1F27e31383BD;
    address internal constant PNK = 0x34B944D42cAcfC8266955D07A80181D2054aa225;
    address internal constant PNK_FAUCET = 0x9f6ffc13B685A68ae359fCA128dfE776458Df464;
}
