// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {BridgeCodec} from "../../../src/shared/BridgeCodec.sol";

/// @notice TEST MOCK, unit tests only. Plays the Hedera claims contract on the local CCIP simulator: sends a
/// `ClaimToCourt` payload to the case contract and keeps every `RulingBack` it receives. It never decides anything.
contract MockClaimsPeer is CCIPReceiver {
    struct Got {
        bytes32 messageId;
        uint64 sourceSelector;
        bytes sender;
        bytes data;
    }

    Got[] internal got;

    constructor(address router) CCIPReceiver(router) {}

    receive() external payable {}

    function sendClaim(uint64 destSelector, address receiver, bytes calldata payload) external returns (bytes32) {
        Client.EVM2AnyMessage memory m = Client.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            data: payload,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            extraArgs: BridgeCodec.extraArgsFor(300_000)
        });
        uint256 fee = IRouterClient(getRouter()).getFee(destSelector, m);
        return IRouterClient(getRouter()).ccipSend{value: fee}(destSelector, m);
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        got.push(Got(message.messageId, message.sourceChainSelector, message.sender, message.data));
    }

    function receivedCount() external view returns (uint256) {
        return got.length;
    }

    function receivedAt(uint256 i) external view returns (Got memory) {
        return got[i];
    }
}
