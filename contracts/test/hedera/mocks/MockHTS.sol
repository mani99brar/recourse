// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MockHtsUsdc} from "./MockHtsUsdc.sol";

/// @title MockHTS (local tests and anvil only; never deployed to a live network)
/// @notice Stands in for the HTS system contract at 0x167. `associateToken` records the association
///         on the mock token itself, so the system-contract path and the token's own `associate()`
///         mark the same accounts. A response code or a revert can be forced for failure tests.
/// @dev Etch-safe: no constructor, zero storage means "behave normally".
contract MockHTS {
    int64 internal constant INVALID_SIGNATURE = 7;

    bool public forceCode;
    int64 public forcedCode;
    bool public forceRevert;

    error MockHtsReverted();

    function associateToken(address account, address token) external returns (int64 responseCode) {
        if (forceRevert) revert MockHtsReverted();
        if (forceCode) return forcedCode;
        // The real service needs the account's own authorisation; a contract acting for itself has it.
        if (account != msg.sender) return INVALID_SIGNATURE;
        return MockHtsUsdc(token).mockAssociate(account);
    }

    function setResponseCode(int64 code) external {
        forceCode = true;
        forcedCode = code;
    }

    function clearResponseCode() external {
        forceCode = false;
        forcedCode = 0;
    }

    function setRevert(bool on) external {
        forceRevert = on;
    }
}
