// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice TEST MOCK, local runs only. Answers `getExecutionState(bytes32 messageId)` like a CCIP OffRamp
/// (0 untouched, 1 in progress, 2 success, 3 failure) for local runs, where a relay process stands in for CCIP and
/// sets the state after it delivers (or fails to deliver) a message.
contract MockOffRamp {
    mapping(bytes32 => uint8) internal states;

    event ExecutionStateSet(bytes32 indexed messageId, uint8 state);

    error MockBadState(uint8 state);

    function getExecutionState(bytes32 messageId) external view returns (uint8) {
        return states[messageId];
    }

    /// @notice Test-only setter. Anyone may call: this is a mock.
    function setExecutionState(bytes32 messageId, uint8 state) external {
        if (state > 3) revert MockBadState(state);
        states[messageId] = state;
        emit ExecutionStateSet(messageId, state);
    }
}
