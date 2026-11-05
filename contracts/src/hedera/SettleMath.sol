// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Codes} from "../shared/RecourseTypes.sol";

/// @title SettleMath
/// @notice The settle table. Integer micro-USDC, floor division. `fee` is always the fee escrowed for
///         the claim, never the current court-fee parameter.
///
///         | Path                                  | toShop (from deposit) | refund | toPool | outcome |
///         | ruling 1                              | netLoss + H + fee     | 0      | fee    | 1       |
///         | ruling 2                              | 0                     | 0      | fee    | 2       |
///         | ruling 3, gap 1 or 2                  | fee                   | 0      | fee    | 3       |
///         | ruling 3, any other gap               | 0                     | 0      | fee    | 3       |
///         | ruling 0 twice, answer 1, 2 or 3      | as that ruling        | 0      | fee    | answer  |
///         | ruling 0 twice, answer 0              | floor(fee / 2)        | 0      | fee    | 0       |
///         | closed uncontested, answer 1          | netLoss + H           | fee    | 0      |         |
///         | closed uncontested, answer 0, 2 or 3  | 0                     | fee    | 0      |         |
///         | expired                               | 0                     | fee    | 0      |         |
///
///         H = min(handlingBase + floor(basket * handlingBps / 10000), handlingCap).
/// @dev Inputs are bounded upstream (amounts below 2^128, bps at most 10000), so no sum overflows.
library SettleMath {
    uint256 internal constant BPS = 10_000;

    function handling(uint256 basketUsdc, uint256 base, uint256 bps, uint256 cap) internal pure returns (uint256) {
        uint256 h = base + (basketUsdc * bps) / BPS;
        return h < cap ? h : cap;
    }

    /// @notice A ruled claim. A ruling of 0 only reaches here after two refusals, and then the
    ///         pre-check answer stands in for it.
    /// @return outcome The code applied (the ruling, or the answer after two refusals).
    /// @return toShop Owed to the shop from the platform's deposit, before the deposit cap.
    function ruled(uint8 ruling, uint8 gap, uint8 answer, uint256 netLossUsdc, uint256 handling_, uint256 fee)
        internal
        pure
        returns (uint8 outcome, uint256 toShop)
    {
        uint8 applied = ruling;
        if (ruling == Codes.RULING_REFUSED) {
            if (answer == Codes.ANSWER_UNKNOWN) return (0, fee / 2);
            applied = answer;
        }
        if (applied == Codes.RULING_PLATFORM) return (applied, netLossUsdc + handling_ + fee);
        if (applied == Codes.RULING_MERCHANT) return (applied, 0);
        // Neither side at fault: the platform still covers the fee when the pre-check found a gap
        // on the order path (1 or 2).
        bool flagged = gap == Codes.GAP_ASKED_VS_SHOWN || gap == Codes.GAP_SHOWN_VS_ORDERED;
        return (applied, flagged ? fee : 0);
    }

    /// @notice A claim closed without a contest; the fee is refunded separately.
    function uncontested(uint8 answer, uint256 netLossUsdc, uint256 handling_) internal pure returns (uint256 toShop) {
        return answer == Codes.ANSWER_PLATFORM ? netLossUsdc + handling_ : 0;
    }
}
