// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ClaimToCourt} from "../shared/RecourseTypes.sol";

/// @notice Builds the Kleros dispute template of a claim:
///   part0 + FACTS + part1 + POLICY_URI + part2 + ALIASES + part3
/// FACTS and ALIASES come from the ClaimToCourt fields only. Addresses and hashes are lowercase 0x hex and integers
/// plain decimal, so the bytes equal the TypeScript `buildTemplate` in packages/court for the same inputs (a golden
/// file test pins this). Lines inside FACTS are joined by the two characters backslash and n, a newline escape
/// inside the JSON string the parts open.
library CaseTemplate {
    using Strings for uint256;
    using Strings for address;

    string internal constant NL = "\\n";

    function build(string[4] memory parts, ClaimToCourt memory c, string memory policyURI)
        internal
        pure
        returns (string memory)
    {
        string memory head = string.concat(parts[0], facts(c), parts[1]);
        return string.concat(head, policyURI, parts[2], aliases(c), parts[3]);
    }

    function facts(ClaimToCourt memory c) internal pure returns (string memory) {
        string memory parties = string.concat(
            _line("- Claim id: ", _h32(c.claimId)),
            _line("- Agent company (platform): ", c.platform.toHexString()),
            _line("- Shop: ", c.shop.toHexString())
        );
        string memory codes = string.concat(
            _line("- Pre-check gap code: ", uint256(c.gap).toString()),
            _line("- Pre-check answer code: ", uint256(c.answer).toString())
        );
        string memory money = string.concat(
            _line("- Basket paid: ", string.concat(c.basketUsdc.toString(), " micro-USDC")),
            _line("- Net loss claimed: ", string.concat(c.netLossUsdc.toString(), " micro-USDC")),
            _line("- Filed at: ", string.concat(uint256(c.filedAt).toString(), " (unix seconds)"))
        );
        string memory refsHead = string.concat(
            _line("- Pre-check document SHA-256: ", _h32(c.packHash)),
            _line("- Record topic: HCS 0.0.", uint256(c.refs.topicNum).toString()),
            "- Records (kind: HCS sequence number, SHA-256):"
        );
        string memory records;
        for (uint256 k = 0; k < 6; k++) {
            records = string.concat(records, NL, "  - ", _label(k), ": ", _recordRef(c, k));
        }
        return string.concat(parties, codes, money, refsHead, records);
    }

    function _line(string memory label, string memory value) private pure returns (string memory) {
        return string.concat(label, value, NL);
    }

    function _recordRef(ClaimToCourt memory c, uint256 k) private pure returns (string memory) {
        return string.concat(uint256(c.refs.seq[k]).toString(), ", ", _h32(c.refs.hashes[k]));
    }

    function aliases(ClaimToCourt memory c) internal pure returns (string memory) {
        return string.concat('"Agent company":"', c.platform.toHexString(), '","Shop":"', c.shop.toHexString(), '"');
    }

    function _h32(bytes32 h) private pure returns (string memory) {
        return uint256(h).toHexString(32);
    }

    function _label(uint256 k) private pure returns (string memory) {
        if (k == 0) return "asked (I)";
        if (k == 1) return "shown (S)";
        if (k == 2) return "approval (A)";
        if (k == 3) return "ordered (O)";
        if (k == 4) return "packed (D)";
        return "arrived (R)";
    }
}

/// @notice Stores a byte string as the code of a small contract, so reading it back costs one EXTCODECOPY rather
/// than one SLOAD per word. The code starts with a STOP byte, so calling the store does nothing.
library TextStore {
    error TextStoreWriteFailed();

    function write(bytes memory data) internal returns (address pointer) {
        bytes memory runtime = abi.encodePacked(hex"00", data);
        // PUSH4 len, DUP1, PUSH1 14, PUSH1 0, CODECOPY, PUSH1 0, RETURN, then the runtime code.
        bytes memory creation = abi.encodePacked(hex"63", uint32(runtime.length), hex"80600e6000396000f3", runtime);
        assembly ("memory-safe") {
            pointer := create(0, add(creation, 32), mload(creation))
        }
        if (pointer == address(0)) revert TextStoreWriteFailed();
    }

    function read(address pointer) internal view returns (bytes memory data) {
        uint256 size = pointer.code.length;
        if (size == 0) return data;
        unchecked {
            size -= 1;
        }
        data = new bytes(size);
        assembly ("memory-safe") {
            extcodecopy(pointer, add(data, 32), 1, size)
        }
    }
}
