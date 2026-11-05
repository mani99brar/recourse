// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {CaseState, ClaimToCourt} from "../../src/shared/RecourseTypes.sol";
import {RecourseCase} from "../../src/arbitrum/RecourseCase.sol";
import {CaseView} from "../../src/arbitrum/IRecourseCase.sol";
import {MockArbitrator} from "./mocks/MockArbitrator.sol";
import {MockTemplateRegistry} from "./mocks/MockTemplateRegistry.sol";
import {MockClaimsPeer} from "./mocks/MockClaimsPeer.sol";

/// @dev Valid ClaimToCourt payloads for test claim number `n`.
library TestPayloads {
    /// @dev A valid ClaimToCourt for claim number `n`, with every field filled.
    function claimOf(uint256 n) internal pure returns (ClaimToCourt memory c) {
        c.version = BridgeCodec.VERSION;
        c.claimId = keccak256(abi.encode("recourse.test.claim", n));
        c.platform = address(uint160(uint256(keccak256(abi.encode("platform", n)))));
        c.shop = address(uint160(uint256(keccak256(abi.encode("shop", n)))));
        c.gap = 1;
        c.answer = 1;
        c.refs.topicNum = 7_000_001;
        for (uint256 k = 0; k < 6; k++) {
            c.refs.seq[k] = uint64(100 + k);
            c.refs.hashes[k] = keccak256(abi.encode("record", n, k));
        }
        c.packHash = keccak256(abi.encode("pack", n));
        c.basketUsdc = 120_000_000;
        c.netLossUsdc = 45_000_000;
        c.filedAt = uint64(1_800_000_000 - 1 hours);
    }

    function payloadOf(uint256 n) internal pure returns (bytes memory) {
        return BridgeCodec.encodeClaimToCourt(claimOf(n));
    }

    function idOf(uint256 n) internal pure returns (bytes32) {
        return claimOf(n).claimId;
    }
}

/// @dev Shared setup: RecourseCase on the chainlink-local simulator, a mock court, a mock template registry and a
/// mock Hedera peer. The simulator stamps every message with its own chain selector, so the case is built with that
/// selector as "Hedera". Template text and policy come from the court package's golden file, so the template bytes
/// tested here are the ones the TypeScript builder produces.
abstract contract CaseBase is Test {
    string internal constant GOLDEN = "../packages/court/template/golden.json";
    string internal constant VECTORS = "../packages/shared/vectors/";

    uint256 internal constant COST = 810_000_000_000_000;
    uint256 internal constant POOL = 0.01 ether;
    uint64 internal constant DEADLINE = 2 hours;
    uint16 internal constant MAX_OPEN = 10;
    uint64 internal constant RESEND_GAP = 30 minutes;
    uint8 internal constant MAX_SENDS = 5;
    uint256 internal constant RELAY_GAS = 400_000;
    uint256 internal constant T0 = 1_800_000_000;

    CCIPLocalSimulator internal sim;
    CCIPLocalRouter internal router;
    IERC20 internal link;
    uint64 internal sel;

    MockArbitrator internal arb;
    MockTemplateRegistry internal reg;
    MockClaimsPeer internal peer;
    RecourseCase internal rc;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal keeper = makeAddr("keeper");

    string internal golden;
    string internal policyURI;

    function setUp() public virtual {
        vm.warp(T0);
        sim = new CCIPLocalSimulator();
        (uint64 chainSelector, address source,,, address linkToken,,) = _rawConfig();
        sel = chainSelector;
        router = CCIPLocalRouter(source);
        link = IERC20(linkToken);

        arb = new MockArbitrator(COST, 1233);
        reg = new MockTemplateRegistry();
        peer = new MockClaimsPeer(address(router));
        rc = _deploy();

        golden = vm.readFile(GOLDEN);
        policyURI = vm.parseJsonString(golden, ".policyURI");
        vm.startPrank(owner);
        rc.setPeer(address(peer));
        rc.setTemplateText(variantParts(0));
        rc.setPolicyURI(policyURI);
        vm.stopPrank();

        vm.deal(address(this), 10 ether);
        rc.fundFeePool{value: POOL}();
        sim.requestLinkFromFaucet(address(rc), 5 ether);
    }

    function _deploy() internal returns (RecourseCase) {
        return new RecourseCase(
            address(router),
            address(link),
            address(arb),
            address(reg),
            sel,
            owner,
            RecourseCase.Params({
                caseDeadline: DEADLINE, maxOpenCases: MAX_OPEN, resendGap: RESEND_GAP, maxSends: MAX_SENDS
            }),
            RELAY_GAS
        );
    }

    /// @dev `configuration()` returns contract types from several OZ copies; decode it as plain addresses.
    function _rawConfig() internal view returns (uint64, address, address, address, address, address, address) {
        (bool ok, bytes memory ret) = address(sim).staticcall(abi.encodeCall(CCIPLocalSimulator.configuration, ()));
        require(ok, "config");
        return abi.decode(ret, (uint64, address, address, address, address, address, address));
    }

    // ------------------------------------------------------------------ golden data

    function variantParts(uint256 i) internal view returns (string[4] memory parts) {
        for (uint256 k = 0; k < 4; k++) {
            parts[k] = string(
                vm.parseJsonBytes(golden, string.concat(".variants[", vm.toString(i), "].parts[", vm.toString(k), "]"))
            );
        }
    }

    function goldenCaseCount() internal view returns (uint256) {
        uint256 n;
        while (vm.keyExistsJson(golden, string.concat(".cases[", vm.toString(n), "]"))) n++;
        return n;
    }

    function goldenCase(uint256 i)
        internal
        view
        returns (uint256 variant, bytes memory payload, string memory template)
    {
        string memory p = string.concat(".cases[", vm.toString(i), "]");
        variant = vm.parseJsonUint(golden, string.concat(p, ".variant"));
        payload = vm.parseJsonBytes(golden, string.concat(p, ".payload"));
        template = string(vm.parseJsonBytes(golden, string.concat(p, ".template")));
    }

    function codecJson() internal view returns (string memory) {
        return vm.readFile(string.concat(VECTORS, "codec.json"));
    }

    // ------------------------------------------------------------------ payloads

    function claimOf(uint256 n) internal pure returns (ClaimToCourt memory) {
        return TestPayloads.claimOf(n);
    }

    function payloadOf(uint256 n) internal pure returns (bytes memory) {
        return TestPayloads.payloadOf(n);
    }

    function idOf(uint256 n) internal pure returns (bytes32) {
        return TestPayloads.idOf(n);
    }

    // ------------------------------------------------------------------ flows

    function deliver(bytes memory payload) internal returns (bytes32 messageId) {
        return peer.sendClaim(sel, address(rc), payload);
    }

    /// @dev Delivers a crafted message as the router would, bypassing the simulator's own stamping.
    function deliverRaw(bytes32 messageId, uint64 source, bytes memory sender, bytes memory data) internal {
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: messageId,
            sourceChainSelector: source,
            sender: sender,
            data: data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.prank(address(router));
        rc.ccipReceive(m);
    }

    function receiveAndOpen(uint256 n) internal returns (uint256 disputeId) {
        bytes memory payload = payloadOf(n);
        deliver(payload);
        vm.prank(keeper);
        disputeId = rc.openCase(payload);
    }

    function toRuled(uint256 n, uint256 ruling) internal returns (uint256 disputeId) {
        disputeId = receiveAndOpen(n);
        arb.giveRuling(disputeId, ruling);
    }

    function stateOf(bytes32 claimId) internal view returns (CaseState) {
        return rc.caseOf(claimId).state;
    }

    function viewOf(bytes32 claimId) internal view returns (CaseView memory) {
        return rc.caseOf(claimId);
    }
}

/// @dev Deploys RecourseCase through an external call, so constructor reverts can be asserted.
contract CaseDeployer {
    function deploy(
        address router,
        address link_,
        address arbitrator_,
        address registry,
        uint64 hederaSelector_,
        address owner_,
        RecourseCase.Params memory init,
        uint256 relayGasLimit
    ) external returns (address) {
        return address(
            new RecourseCase(router, link_, arbitrator_, registry, hederaSelector_, owner_, init, relayGasLimit)
        );
    }
}

/// @dev Refuses every ETH transfer; used to prove failed refunds and withdrawals are handled.
contract EthRefuser {
    function exec(address target, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}
