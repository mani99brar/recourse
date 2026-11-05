// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {IArbitrableV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitrableV2.sol";
import {IArbitratorV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitratorV2.sol";
import {IDisputeTemplateRegistry} from
    "@kleros/kleros-v2-contracts/arbitration/interfaces/IDisputeTemplateRegistry.sol";

/// Minimal receiver that proves the CCIP receiver base compiles against our remappings.
contract SmokeReceiver is CCIPReceiver {
    bytes32 public lastId;

    constructor(address router) CCIPReceiver(router) {}

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        lastId = message.messageId;
    }
}

contract ImportSmokeTest is Test {
    function test_LibrariesCompileAndLink() public {
        CCIPLocalSimulator sim = new CCIPLocalSimulator();
        (uint64 selector, IRouterClient router,,,,,) = sim.configuration();
        SmokeReceiver receiver = new SmokeReceiver(address(router));
        assertEq(receiver.getRouter(), address(router));
        assertGt(selector, 0);

        bytes memory args = Client._argsToBytes(
            Client.GenericExtraArgsV2({gasLimit: 300_000, allowOutOfOrderExecution: true})
        );
        assertEq(bytes4(args), Client.GENERIC_EXTRA_ARGS_V2_TAG);

        assertTrue(type(IArbitrableV2).interfaceId != bytes4(0));
        assertTrue(type(IArbitratorV2).interfaceId != bytes4(0));
        assertTrue(type(IDisputeTemplateRegistry).interfaceId != bytes4(0));
        assertTrue(type(IERC20).interfaceId != bytes4(0));
    }
}
