// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IEvidence} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IEvidence.sol";

/// @notice TEST MOCK, local runs only. `submitEvidence` emits the same `Evidence` event as the Kleros
/// EvidenceModule, so local tooling that reads evidence logs works unchanged.
contract MockEvidenceModule is IEvidence {
    function submitEvidence(uint256 externalDisputeID, string calldata evidence) external {
        emit Evidence(externalDisputeID, msg.sender, evidence);
    }
}
