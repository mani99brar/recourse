// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    IDisputeTemplateRegistry
} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IDisputeTemplateRegistry.sol";

/// @notice TEST MOCK, local runs only. Same interface and event as the Kleros DisputeTemplateRegistry, which only
/// emits the template. This mock also keeps the keccak256 of each template and mappings string (not the text, so gas
/// stays close to the real registry) so tests can compare the registered bytes.
contract MockTemplateRegistry is IDisputeTemplateRegistry {
    uint256 public templates;
    mapping(uint256 => bytes32) public templateHashOf;
    mapping(uint256 => bytes32) public mappingsHashOf;

    function setDisputeTemplate(string memory tag, string memory data, string memory mappings)
        external
        returns (uint256 templateId)
    {
        templateId = templates++;
        templateHashOf[templateId] = keccak256(bytes(data));
        mappingsHashOf[templateId] = keccak256(bytes(mappings));
        emit DisputeTemplate(templateId, tag, data, mappings);
    }
}
