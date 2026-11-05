// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {RecourseIds} from "../../src/shared/RecourseIds.sol";
import {RecourseAddresses as A} from "../../src/shared/RecourseAddresses.sol";
import {ClaimToCourt, RulingBack, DecodeStatus} from "../../src/shared/RecourseTypes.sol";

/// The same golden vectors the TypeScript tests read, so both sides agree byte for byte.
contract SharedVectorsTest is Test {
    string internal constant DIR = "../packages/shared/vectors/";

    function _json(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(DIR, name));
    }

    function test_Ids() public view {
        string memory j = _json("ids.json");
        bytes32 orderId = RecourseIds.orderIdOf(
            vm.parseJsonAddress(j, ".orderId.platform"),
            vm.parseJsonAddress(j, ".orderId.shop"),
            vm.parseJsonBytes32(j, ".orderId.orderNonce")
        );
        assertEq(orderId, vm.parseJsonBytes32(j, ".orderId.expected"));

        for (uint256 i = 0; i < 2; i++) {
            string memory p = string.concat(".claimId[", vm.toString(i), "]");
            bytes32 claimId = RecourseIds.claimIdOf(
                vm.parseJsonUint(j, string.concat(p, ".chainId")),
                vm.parseJsonAddress(j, string.concat(p, ".claims")),
                vm.parseJsonBytes32(j, string.concat(p, ".orderId"))
            );
            assertEq(claimId, vm.parseJsonBytes32(j, string.concat(p, ".expected")));

            string memory e = string.concat(".externalId[", vm.toString(i), "]");
            bytes32 ext = RecourseIds.externalIdOf(
                vm.parseJsonUint(j, string.concat(e, ".chainId")),
                vm.parseJsonAddress(j, string.concat(e, ".recourseCase")),
                vm.parseJsonBytes32(j, string.concat(e, ".claimId")),
                uint8(vm.parseJsonUint(j, string.concat(e, ".attempt")))
            );
            assertEq(ext, vm.parseJsonBytes32(j, string.concat(e, ".expected")));
            assertEq(uint256(ext), vm.parseJsonUint(j, string.concat(e, ".expectedUint")));
        }
    }

    function test_ClaimIdOnHedera() public {
        string memory j = _json("ids.json");
        vm.chainId(296);
        assertEq(
            RecourseIds.claimIdOf(block.chainid, vm.parseJsonAddress(j, ".claimId[0].claims"), vm.parseJsonBytes32(j, ".claimId[0].orderId")),
            vm.parseJsonBytes32(j, ".claimId[0].expected")
        );
    }

    function _claimAt(string memory j, string memory p) internal pure returns (ClaimToCourt memory m) {
        string memory v = string.concat(p, ".value");
        m.version = uint8(vm.parseJsonUint(j, string.concat(v, ".version")));
        m.claimId = vm.parseJsonBytes32(j, string.concat(v, ".claimId"));
        m.platform = vm.parseJsonAddress(j, string.concat(v, ".platform"));
        m.shop = vm.parseJsonAddress(j, string.concat(v, ".shop"));
        m.gap = uint8(vm.parseJsonUint(j, string.concat(v, ".gap")));
        m.answer = uint8(vm.parseJsonUint(j, string.concat(v, ".answer")));
        m.refs.topicNum = uint64(vm.parseJsonUint(j, string.concat(v, ".refs.topicNum")));
        uint256[] memory seq = vm.parseJsonUintArray(j, string.concat(v, ".refs.seq"));
        bytes32[] memory hashes = vm.parseJsonBytes32Array(j, string.concat(v, ".refs.hashes"));
        for (uint256 i = 0; i < 6; i++) {
            m.refs.seq[i] = uint64(seq[i]);
            m.refs.hashes[i] = hashes[i];
        }
        m.packHash = vm.parseJsonBytes32(j, string.concat(v, ".packHash"));
        m.basketUsdc = vm.parseJsonUint(j, string.concat(v, ".basketUsdc"));
        m.netLossUsdc = vm.parseJsonUint(j, string.concat(v, ".netLossUsdc"));
        m.filedAt = uint64(vm.parseJsonUint(j, string.concat(v, ".filedAt")));
    }

    function test_ClaimToCourtVectors() public view {
        string memory j = _json("codec.json");
        for (uint256 i = 0; i < 2; i++) {
            string memory p = string.concat(".claimToCourt[", vm.toString(i), "]");
            ClaimToCourt memory m = _claimAt(j, p);
            bytes memory expected = vm.parseJsonBytes(j, string.concat(p, ".encoded"));
            assertEq(BridgeCodec.encodeClaimToCourt(m), expected);
            assertEq(BridgeCodec.payloadHash(expected), vm.parseJsonBytes32(j, string.concat(p, ".payloadHash")));
            (DecodeStatus s, ClaimToCourt memory back) = BridgeCodec.tryDecodeClaimToCourt(expected);
            assertEq(uint8(s), uint8(DecodeStatus.Ok));
            assertEq(abi.encode(back), abi.encode(m));
        }
    }

    function test_RulingBackVectors() public view {
        string memory j = _json("codec.json");
        for (uint256 i = 0; i < 2; i++) {
            string memory p = string.concat(".rulingBack[", vm.toString(i), "]");
            RulingBack memory m = RulingBack({
                version: uint8(vm.parseJsonUint(j, string.concat(p, ".value.version"))),
                claimId: vm.parseJsonBytes32(j, string.concat(p, ".value.claimId")),
                disputeId: vm.parseJsonUint(j, string.concat(p, ".value.disputeId")),
                ruling: uint8(vm.parseJsonUint(j, string.concat(p, ".value.ruling"))),
                attempts: uint8(vm.parseJsonUint(j, string.concat(p, ".value.attempts")))
            });
            bytes memory expected = vm.parseJsonBytes(j, string.concat(p, ".encoded"));
            assertEq(BridgeCodec.encodeRulingBack(m), expected);
            (DecodeStatus s, RulingBack memory back) = BridgeCodec.tryDecodeRulingBack(expected);
            assertEq(uint8(s), uint8(DecodeStatus.Ok));
            assertEq(abi.encode(back), abi.encode(m));
        }
    }

    function test_ExtraArgsVectors() public view {
        string memory j = _json("codec.json");
        for (uint256 i = 0; i < 2; i++) {
            string memory p = string.concat(".extraArgs[", vm.toString(i), "]");
            assertEq(
                BridgeCodec.extraArgsFor(vm.parseJsonUint(j, string.concat(p, ".gasLimit"))),
                vm.parseJsonBytes(j, string.concat(p, ".encoded"))
            );
        }
    }

    function test_AddressesMatchTheBook() public view {
        string memory j = _json("addresses.json");
        assertEq(A.HEDERA_CHAIN_ID, vm.parseJsonUint(j, ".hedera.chainId"));
        assertEq(uint256(A.HEDERA_SELECTOR), vm.parseJsonUint(j, ".hedera.ccipSelector"));
        assertEq(A.HEDERA_ROUTER, vm.parseJsonAddress(j, ".hedera.router"));
        assertEq(A.HEDERA_ONRAMP, vm.parseJsonAddress(j, ".hedera.onRamp"));
        assertEq(A.HEDERA_OFFRAMP, vm.parseJsonAddress(j, ".hedera.offRamp"));
        assertEq(A.HEDERA_LINK, vm.parseJsonAddress(j, ".hedera.link"));
        assertEq(A.HEDERA_USDC, vm.parseJsonAddress(j, ".hedera.usdcFacade"));
        assertEq(uint160(A.HEDERA_USDC), 429274);
        assertEq(A.HEDERA_HTS, vm.parseJsonAddress(j, ".hedera.hts"));
        assertEq(A.HEDERA_PRNG, vm.parseJsonAddress(j, ".hedera.prng"));
        assertEq(A.HEDERA_ERC8004_IDENTITY, vm.parseJsonAddress(j, ".hedera.erc8004Identity"));
        assertEq(A.HEDERA_ERC8004_REPUTATION, vm.parseJsonAddress(j, ".hedera.erc8004Reputation"));

        assertEq(A.ARBITRUM_CHAIN_ID, vm.parseJsonUint(j, ".arbitrum.chainId"));
        assertEq(uint256(A.ARBITRUM_SELECTOR), vm.parseJsonUint(j, ".arbitrum.ccipSelector"));
        assertEq(A.ARBITRUM_ROUTER, vm.parseJsonAddress(j, ".arbitrum.router"));
        assertEq(A.ARBITRUM_ONRAMP, vm.parseJsonAddress(j, ".arbitrum.onRamp"));
        assertEq(A.ARBITRUM_OFFRAMP, vm.parseJsonAddress(j, ".arbitrum.offRamp"));
        assertEq(A.ARBITRUM_LINK, vm.parseJsonAddress(j, ".arbitrum.link"));
        assertEq(A.KLEROS_CORE, vm.parseJsonAddress(j, ".arbitrum.klerosCore"));
        assertEq(A.DISPUTE_TEMPLATE_REGISTRY, vm.parseJsonAddress(j, ".arbitrum.disputeTemplateRegistry"));
        assertEq(A.EVIDENCE_MODULE, vm.parseJsonAddress(j, ".arbitrum.evidenceModule"));
        assertEq(A.DISPUTE_RESOLVER, vm.parseJsonAddress(j, ".arbitrum.disputeResolver"));
        assertEq(A.DISPUTE_KIT_CLASSIC, vm.parseJsonAddress(j, ".arbitrum.disputeKitClassic"));
        assertEq(A.SORTITION_MODULE, vm.parseJsonAddress(j, ".arbitrum.sortitionModule"));
        assertEq(A.PNK, vm.parseJsonAddress(j, ".arbitrum.pnk"));
        assertEq(A.PNK_FAUCET, vm.parseJsonAddress(j, ".arbitrum.pnkFaucet"));
    }
}
