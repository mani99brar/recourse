// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IArbitratorV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitratorV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RecourseAddresses as A} from "../../src/shared/RecourseAddresses.sol";
import {CaseState} from "../../src/shared/RecourseTypes.sol";
import {RecourseCase} from "../../src/arbitrum/RecourseCase.sol";

interface IKlerosCorePaused {
    function paused() external view returns (bool);
}

/// @notice Read-only fork of Arbitrum Sepolia: the live arbitration cost, the court not paused, and the gas of every
/// RecourseCase step against the real KlerosCore, DisputeTemplateRegistry and CCIP Router. Everything happens on the
/// local fork; nothing is sent to the network.
///
///   forge test --match-path 'test/arbitrum/RecourseCaseFork.t.sol' --fork-url "$ARB_RPC_URL" -vv
///
/// Skipped without a fork. With CASE_GAS_OUT set to a bare `*.local.json` name it also writes the measured gas, plus
/// a 25% margin, to that file in deployments/; `script/arbitrum/gas.sh` runs this at a pinned Arbitrum block and
/// merges the result into arbitrum.json as `gas`, with that block and the time.
/// Each step is measured with the case's storage cooled first, as in its own transaction. This is execution gas
/// only; an Arbitrum transaction adds its L1 data charge on top, which `eth_estimateGas` includes.
contract RecourseCaseForkTest is Test {
    uint256 internal constant MARGIN_PCT = 25;
    uint256 internal constant EXPECTED_COST = 810_000_000_000_000;
    string internal constant GOLDEN = "../packages/court/template/golden.json";
    string internal constant CODEC = "../packages/shared/vectors/codec.json";
    string internal constant PARAMS = "../packages/shared/vectors/params.json";

    RecourseCase internal rc;
    address internal claimsPeer = makeAddr("hedera-claims");
    bytes internal payload;
    bytes32 internal claimId;

    struct Measured {
        uint256 gReceive;
        uint256 gOpen;
        uint256 gRefile;
        uint256 gRefuse;
        uint256 gFinal;
        uint256 gIgnored;
        uint256 gRelayLink;
        uint256 gRelayNative;
    }

    Measured internal m;

    function setUp() public {
        if (block.chainid != A.ARBITRUM_CHAIN_ID) return;
        string memory golden = vm.readFile(GOLDEN);
        string[4] memory parts;
        for (uint256 k = 0; k < 4; k++) {
            parts[k] = string(vm.parseJsonBytes(golden, string.concat(".variants[0].parts[", vm.toString(k), "]")));
        }
        rc = new RecourseCase(
            A.ARBITRUM_ROUTER,
            A.ARBITRUM_LINK,
            A.KLEROS_CORE,
            A.DISPUTE_TEMPLATE_REGISTRY,
            A.HEDERA_SELECTOR,
            address(this),
            RecourseCase.Params({caseDeadline: 2 hours, maxOpenCases: 10, resendGap: 30 minutes, maxSends: 5}),
            vm.parseJsonUint(vm.readFile(PARAMS), ".preLock.gasRulingBack"),
            uint64(vm.parseJsonUint(vm.readFile(PARAMS), ".locked.claimTimeout"))
        );
        rc.setTemplateText(parts);
        rc.setPolicyURI(vm.parseJsonString(golden, ".policyURI"));
        rc.setPeer(claimsPeer);
        vm.deal(address(this), 1 ether);
        rc.fundFeePool{value: 0.01 ether}();
        deal(A.ARBITRUM_LINK, address(rc), 5 ether);

        // The largest valid payload: the shared vector with every uint64 at its maximum.
        string memory codec = vm.readFile(CODEC);
        payload = vm.parseJsonBytes(codec, ".claimToCourt[1].encoded");
        claimId = vm.parseJsonBytes32(codec, ".claimToCourt[1].value.claimId");
    }

    receive() external payable {}

    function test_fork_courtAndGas() public {
        if (block.chainid != A.ARBITRUM_CHAIN_ID) {
            vm.skip(true, "needs --fork-url on Arbitrum Sepolia");
        }
        assertFalse(IKlerosCorePaused(A.KLEROS_CORE).paused(), "KlerosCore paused");
        uint256 cost = rc.costNow();
        emit log_named_uint("live arbitrationCost(court 8, 3 jurors, DK 1) wei", cost);
        assertEq(cost, EXPECTED_COST, "live cost differs from the expected court 8 cost");
        assertTrue(IRouterClient(A.ARBITRUM_ROUTER).isChainSupported(A.HEDERA_SELECTOR), "no Hedera lane");

        m.gReceive = _receive();
        assertEq(uint8(rc.caseOf(claimId).state), uint8(CaseState.Received));

        vm.cool(address(rc));
        uint256 g = gasleft();
        uint256 first = rc.openCase(payload);
        m.gOpen = g - gasleft();
        assertEq(uint8(rc.caseOf(claimId).state), uint8(CaseState.Opened));
        assertEq(rc.feePool(), 0.01 ether - cost);
        emit log_named_uint("dispute id on the fork (attempt 1)", first);

        m.gRefuse = _rule(first, 0);
        assertEq(uint8(rc.caseOf(claimId).state), uint8(CaseState.RefilePending));

        vm.cool(address(rc));
        g = gasleft();
        uint256 second = rc.refile(payload);
        m.gRefile = g - gasleft();
        assertEq(second, first + 1);

        m.gFinal = _rule(second, 1);
        assertEq(uint8(rc.caseOf(claimId).state), uint8(CaseState.Ruled));
        m.gIgnored = _rule(second, 2);

        uint256 fee = rc.quoteRelay(claimId);
        emit log_named_uint("relay fee in LINK (juels)", fee);
        uint256 linkBefore = IERC20(A.ARBITRUM_LINK).balanceOf(address(rc));
        vm.cool(address(rc));
        g = gasleft();
        rc.relayRuling(claimId);
        m.gRelayLink = g - gasleft();
        assertEq(IERC20(A.ARBITRUM_LINK).balanceOf(address(rc)), linkBefore - fee);

        vm.warp(block.timestamp + 30 minutes);
        uint256 nativeFee = rc.quoteRelayNative(claimId);
        emit log_named_uint("relay fee in native (wei)", nativeFee);
        vm.cool(address(rc));
        g = gasleft();
        rc.relayRuling{value: nativeFee}(claimId);
        m.gRelayNative = g - gasleft();
        assertEq(rc.caseOf(claimId).sendCount, 2);

        emit log_named_uint("gas ccipReceive (largest valid payload)", m.gReceive);
        emit log_named_uint("gas openCase", m.gOpen);
        emit log_named_uint("gas refile", m.gRefile);
        emit log_named_uint("gas rule (refusal)", m.gRefuse);
        emit log_named_uint("gas rule (final)", m.gFinal);
        emit log_named_uint("gas rule (ignored)", m.gIgnored);
        emit log_named_uint("gas relayRuling (LINK)", m.gRelayLink);
        emit log_named_uint("gas relayRuling (native)", m.gRelayNative);

        string memory out = vm.envOr("CASE_GAS_OUT", string(""));
        if (bytes(out).length == 0) return;
        _checkName(out);
        string memory a = string.concat(
            _num("marginPct", MARGIN_PCT),
            ",",
            _op("ccipReceive", m.gReceive),
            ",",
            _op("openCase", m.gOpen),
            ",",
            _op("refile", m.gRefile)
        );
        string memory b = string.concat(
            _op("ruleRefuse", m.gRefuse),
            ",",
            _op("ruleFinal", m.gFinal),
            ",",
            _op("ruleIgnored", m.gIgnored),
            ",",
            _op("relayRulingLink", m.gRelayLink),
            ",",
            _op("relayRulingNative", m.gRelayNative)
        );
        vm.writeFile(string.concat(vm.projectRoot(), "/../deployments/", out), string.concat("{", a, ",", b, "}\n"));
    }

    function _receive() internal returns (uint256 used) {
        Client.Any2EVMMessage memory msg_ = Client.Any2EVMMessage({
            messageId: keccak256("fork.message"),
            sourceChainSelector: A.HEDERA_SELECTOR,
            sender: abi.encode(claimsPeer),
            data: payload,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.cool(address(rc));
        vm.prank(A.ARBITRUM_ROUTER);
        uint256 g = gasleft();
        rc.ccipReceive(msg_);
        used = g - gasleft();
    }

    /// @dev KlerosCore calls `rule` when it executes a ruling; the fork stands in for that call.
    function _rule(uint256 disputeId, uint256 ruling) internal returns (uint256 used) {
        vm.cool(address(rc));
        vm.prank(A.KLEROS_CORE);
        uint256 g = gasleft();
        rc.rule(disputeId, ruling);
        used = g - gasleft();
    }

    function _op(string memory k, uint256 used) internal pure returns (string memory) {
        uint256 limit = used + (used * MARGIN_PCT + 99) / 100;
        return string.concat('"', k, '":{"used":', vm.toString(used), ',"limit":', vm.toString(limit), "}");
    }

    function _num(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat('"', k, '":', vm.toString(v));
    }

    function _checkName(string memory name) internal pure {
        bytes memory f = bytes(name);
        bytes memory tail = bytes(".local.json");
        require(f.length > tail.length, "CASE_GAS_OUT");
        for (uint256 i; i < f.length; ++i) {
            require(f[i] != "/" && f[i] != "\\", "CASE_GAS_OUT must be a bare file name");
        }
        for (uint256 i; i < tail.length; ++i) {
            require(f[f.length - tail.length + i] == tail[i], "CASE_GAS_OUT must end in .local.json");
        }
    }
}
