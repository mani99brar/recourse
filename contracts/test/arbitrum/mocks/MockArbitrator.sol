// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IArbitrableV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitrableV2.sol";
import {IArbitratorV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitratorV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice TEST MOCK, local runs only. Stands in for KlerosCore: a settable cost, a record of every dispute and the
/// exact value paid for it, and `giveRuling`, which calls the arbitrable's `rule` like the real court does after
/// appeals close. It never decides anything itself.
contract MockArbitrator is IArbitratorV2 {
    struct Dispute {
        IArbitrableV2 arbitrable;
        uint256 choices;
        bytes extraData;
        uint256 paid;
        uint256 ruling;
        bool ruled;
    }

    uint256 public cost;
    uint256 public immutable firstId;
    uint256 public nextId;
    Dispute[] internal list;

    error MockWrongValue(uint256 paid, uint256 cost);
    error MockUnknownDispute();
    error MockErc20Unsupported();

    constructor(uint256 cost_, uint256 firstId_) {
        cost = cost_;
        firstId = firstId_;
        nextId = firstId_;
    }

    function setCost(uint256 cost_) external {
        cost = cost_;
    }

    function arbitrationCost(bytes calldata) external view returns (uint256) {
        return cost;
    }

    function arbitrationCost(bytes calldata, IERC20) external pure returns (uint256) {
        revert MockErc20Unsupported();
    }

    /// @dev Takes any value at or above the cost, like KlerosCore; tests assert the exact amount paid.
    function createDispute(uint256 choices, bytes calldata extraData) external payable returns (uint256 disputeID) {
        if (msg.value < cost) revert MockWrongValue(msg.value, cost);
        disputeID = nextId++;
        list.push(Dispute(IArbitrableV2(msg.sender), choices, extraData, msg.value, 0, false));
        emit DisputeCreation(disputeID, IArbitrableV2(msg.sender));
    }

    function createDispute(uint256, bytes calldata, IERC20, uint256) external pure returns (uint256) {
        revert MockErc20Unsupported();
    }

    function currentRuling(uint256 disputeID) external view returns (uint256 ruling, bool tied, bool overridden) {
        Dispute storage d = _get(disputeID);
        return (d.ruling, !d.ruled, false);
    }

    /// @notice Delivers a ruling to the dispute's arbitrable. Anyone may call: this is a mock.
    function giveRuling(uint256 disputeID, uint256 ruling) external {
        Dispute storage d = _get(disputeID);
        d.ruling = ruling;
        d.ruled = true;
        emit Ruling(d.arbitrable, disputeID, ruling);
        d.arbitrable.rule(disputeID, ruling);
    }

    function disputeOf(uint256 disputeID) external view returns (Dispute memory) {
        return _get(disputeID);
    }

    function disputeCount() external view returns (uint256) {
        return list.length;
    }

    function _get(uint256 disputeID) internal view returns (Dispute storage d) {
        if (disputeID < firstId || disputeID >= nextId) revert MockUnknownDispute();
        d = list[disputeID - firstId];
    }
}
