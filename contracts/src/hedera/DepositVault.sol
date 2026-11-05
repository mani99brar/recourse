// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RecourseAddresses} from "../shared/RecourseAddresses.sol";
import {IDepositVault} from "./interfaces/IDepositVault.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";
import {IHRC719} from "./interfaces/IHRC719.sol";

/// @title DepositVault
/// @notice Holds every USDC unit of the scheme on Hedera: platform deposits, the shop's court-fee
///         escrow per claim, and withdrawable credits. The bound claims contract is the only caller
///         that can open or close an escrow, and it can only move money along the settle table it
///         implements. The owner can never move deposits, escrow or credits.
/// @dev Invariant: `usdc.balanceOf(this) >= totalDeposits + totalEscrow + totalCredits`, with equality
///      unless someone transfers USDC to the vault directly (that excess is never counted or recoverable).
///      Accounting never reads the token balance. No function accepts native value.
contract DepositVault is IDepositVault, Ownable2Step, ReentrancyGuard {
    /// @dev Hedera Token Service system contract.
    address internal constant HTS = RecourseAddresses.HEDERA_HTS;
    /// @dev Hedera `ResponseCodeEnum` values treated as a successful association.
    int256 internal constant HTS_SUCCESS = 22;
    int256 internal constant HTS_ALREADY_ASSOCIATED = 194;
    /// @dev Reported when the association call itself reverted or returned no code.
    int256 internal constant CALL_REVERTED = -1;

    address public immutable usdc;
    address public immutable pool;
    address public claims;

    bool public usdcAssociated;
    bool public configLocked;

    uint64 internal _topUpWindow = 7 days;
    uint64 internal _exitDelay = 10 minutes;
    uint256 internal _minDeposit;

    uint256 internal _totalDeposits;
    uint256 internal _totalEscrow;
    uint256 internal _totalCredits;

    mapping(address platform => uint256) internal _deposit;
    mapping(address platform => uint256) internal _required;
    mapping(address platform => uint64) internal _topUpStart;
    mapping(address platform => uint64) internal _exitRequestedAt;
    mapping(address platform => uint256) internal _openClaims;
    mapping(address account => uint256) internal _credit;
    mapping(address shop => uint256) internal _shopEscrow;
    mapping(bytes32 claimId => Escrow) internal _escrows;

    modifier onlyClaims() {
        if (msg.sender != claims || claims == address(0)) revert OnlyClaims();
        _;
    }

    modifier notLocked() {
        if (configLocked) revert ConfigIsLocked();
        _;
    }

    /// @param usdc_ The USDC token's EVM address (on Hedera, the HTS token's long-zero facade address).
    /// @param pool_ The scheme wallet that receives court fees.
    /// @param owner_ Configuration owner.
    constructor(address usdc_, address pool_, address owner_) Ownable(owner_) {
        if (usdc_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        pool = pool_;
    }

    // =================================================================== setup (owner)

    /// @notice Binds the claims contract. Callable once, before the config lock.
    function bindClaims(address claims_) external onlyOwner notLocked {
        if (claims_ == address(0)) revert ZeroAddress();
        if (claims != address(0)) revert AlreadyBound();
        claims = claims_;
        emit ClaimsBound(claims_);
    }

    /// @notice Sets the top-up grace window, the exit delay and the smallest non-zero required deposit.
    function setParams(uint64 topUpWindow_, uint64 exitDelay_, uint256 minDeposit_) external onlyOwner notLocked {
        _topUpWindow = topUpWindow_;
        _exitDelay = exitDelay_;
        _minDeposit = minDeposit_;
        emit ParamsSet(topUpWindow_, exitDelay_, minDeposit_);
    }

    /// @notice Freezes `bindClaims` and `setParams` for good.
    function lockConfig() external onlyOwner notLocked {
        if (claims == address(0)) revert ClaimsNotBound();
        configLocked = true;
        emit ConfigLocked();
    }

    /// @notice Sets the deposit a platform must hold to be in good standing (0 removes it).
    /// @dev Stays callable after the lock; it changes standing only, never balances. Raising the
    ///      requirement above a non-zero deposit starts the top-up clock if none is running.
    function setRequired(address platform, uint256 amount) external onlyOwner {
        if (platform == address(0)) revert ZeroAddress();
        if (amount != 0 && amount < _minDeposit) revert BelowMinDeposit(amount, _minDeposit);
        _required[platform] = amount;
        emit RequiredSet(platform, amount);

        uint256 held = _deposit[platform];
        if (amount == 0 || held >= amount) {
            _clearClock(platform);
        } else if (held > 0 && _topUpStart[platform] == 0) {
            _startClock(platform);
        }
    }

    // =================================================================== anyone

    /// @notice Associates the vault with USDC, through the HTS system contract or, with `viaHrc`,
    ///         through the token's own `associate()`. Idempotent: "already associated" also succeeds.
    function associateUsdc(bool viaHrc) external nonReentrant returns (int256 code) {
        bool ok;
        bytes memory ret;
        if (viaHrc) {
            (ok, ret) = usdc.call(abi.encodeCall(IHRC719.associate, ()));
        } else {
            (ok, ret) = HTS.call(abi.encodeCall(IHederaTokenService.associateToken, (address(this), usdc)));
        }
        code = (ok && ret.length >= 32) ? abi.decode(ret, (int256)) : CALL_REVERTED;
        if (code != HTS_SUCCESS && code != HTS_ALREADY_ASSOCIATED) revert AssociationFailed(code);
        usdcAssociated = true;
        emit UsdcAssociated(code);
    }

    /// @notice Adds `amount` from the caller to `platform`'s deposit. Anyone may top up any platform.
    function postDeposit(address platform, uint256 amount) external nonReentrant {
        if (platform == address(0)) revert ZeroAddress();
        if (!usdcAssociated) revert NotAssociatedYet();
        if (amount == 0) revert AmountZero();

        uint256 balance = _deposit[platform] + amount;
        _deposit[platform] = balance;
        _totalDeposits += amount;
        emit DepositPosted(platform, msg.sender, amount, balance);
        if (balance >= _required[platform]) _clearClock(platform);

        _pull(msg.sender, amount);
    }

    /// @notice Pays the caller's whole credit to the caller. If the token refuses the transfer
    ///         (most often because the caller is not associated with USDC), the call reverts and the
    ///         credit stays.
    function withdrawCredit() external nonReentrant returns (uint256 amount) {
        amount = _credit[msg.sender];
        if (amount == 0) revert NoCredit();
        _credit[msg.sender] = 0;
        _totalCredits -= amount;
        emit CreditWithdrawn(msg.sender, amount);

        (bool ok, bytes memory ret) = usdc.call(abi.encodeCall(IERC20.transfer, (msg.sender, amount)));
        if (!_succeeded(ok, ret)) revert NotAssociated(msg.sender);
    }

    /// @notice Starts the caller's exit clock. New claims against the platform stay allowed meanwhile.
    function requestExit() external nonReentrant {
        if (_deposit[msg.sender] == 0) revert NoDeposit();
        if (_exitRequestedAt[msg.sender] != 0) revert ExitPending();
        _exitRequestedAt[msg.sender] = uint64(block.timestamp);
        emit ExitRequested(msg.sender, block.timestamp + _exitDelay);
    }

    /// @notice After the exit delay, with no open claims, moves the caller's whole deposit to its credit.
    /// @dev The delay is read now, not at request time, so a delay raised at the config lock also
    ///      applies to requests made before it.
    function exit() external nonReentrant returns (uint256 amount) {
        uint256 requestedAt = _exitRequestedAt[msg.sender];
        if (requestedAt == 0) revert ExitNotRequested();
        uint256 availableAt = requestedAt + _exitDelay;
        if (block.timestamp < availableAt) revert ExitTooSoon(availableAt);
        uint256 open = _openClaims[msg.sender];
        if (open != 0) revert OpenClaims(open);

        amount = _deposit[msg.sender];
        _deposit[msg.sender] = 0;
        _totalDeposits -= amount;
        _credit[msg.sender] += amount;
        _totalCredits += amount;
        _exitRequestedAt[msg.sender] = 0;
        emit Exited(msg.sender, amount);
        _clearClock(msg.sender);
    }

    // =================================================================== claims contract only

    /// @notice Pulls `amount` from `shop` into a new escrow for `claimId`.
    function escrowFee(address shop, address platform, uint256 amount, bytes32 claimId)
        external
        onlyClaims
        nonReentrant
    {
        if (!usdcAssociated) revert NotAssociatedYet();
        if (amount == 0) revert AmountZero();
        Escrow storage e = _escrows[claimId];
        if (e.state != EscrowState.None) revert EscrowExists(claimId);

        e.shop = shop;
        e.state = EscrowState.Open;
        e.platform = platform;
        e.amount = amount;
        _shopEscrow[shop] += amount;
        _totalEscrow += amount;
        _openClaims[platform] += 1;
        emit FeeEscrowed(claimId, shop, amount);

        _pull(shop, amount);
    }

    /// @notice Closes `claimId`'s escrow. Pays `toShop` from the platform's deposit, capped at what it
    ///         holds, refunds `refundToShop` of the escrow to the shop and gives the rest of the escrow
    ///         to the pool. Everything lands as credit; nothing is transferred out here.
    /// @return paid The part of `toShop` the deposit covered.
    function applyOutcome(bytes32 claimId, address platform, address shop, uint256 toShop, uint256 refundToShop)
        external
        onlyClaims
        nonReentrant
        returns (uint256 paid)
    {
        Escrow storage e = _escrows[claimId];
        if (e.state != EscrowState.Open || e.platform != platform || e.shop != shop) revert UnknownEscrow(claimId);
        uint256 fee = e.amount;
        if (refundToShop > fee) revert RefundAboveEscrow(refundToShop, fee);

        uint256 held = _deposit[platform];
        paid = toShop < held ? toShop : held;
        uint256 remaining = held - paid;
        uint256 toPool = fee - refundToShop;

        e.state = EscrowState.Closed;
        e.refunded = refundToShop;
        _shopEscrow[shop] -= fee;
        _totalEscrow -= fee;
        _openClaims[platform] -= 1;

        _deposit[platform] = remaining;
        _totalDeposits -= paid;

        _credit[shop] += paid + refundToShop;
        _credit[pool] += toPool;
        _totalCredits += paid + fee;

        emit OutcomeApplied(claimId, platform, shop, paid, refundToShop, toPool);
        if (toShop > paid) emit Shortfall(claimId, platform, toShop - paid);

        // The grace clock starts only when this payout takes a platform that met its requirement
        // below it. A platform already short (with no clock) stays out of good standing.
        uint256 req = _required[platform];
        if (req != 0 && held >= req && remaining < req && _topUpStart[platform] == 0) _startClock(platform);
    }

    // =================================================================== views

    function params() external view returns (uint64 topUpWindow, uint64 exitDelay, uint256 minDeposit) {
        return (_topUpWindow, _exitDelay, _minDeposit);
    }

    function depositOf(address platform) external view returns (uint256) {
        return _deposit[platform];
    }

    function requiredOf(address platform) external view returns (uint256) {
        return _required[platform];
    }

    function creditOf(address account) external view returns (uint256) {
        return _credit[account];
    }

    function escrowOf(bytes32 claimId) external view returns (Escrow memory) {
        return _escrows[claimId];
    }

    function shopEscrowOf(address shop) external view returns (uint256) {
        return _shopEscrow[shop];
    }

    function totals() external view returns (uint256 deposits, uint256 escrow, uint256 credits) {
        return (_totalDeposits, _totalEscrow, _totalCredits);
    }

    function topUpStartedAt(address platform) external view returns (uint64) {
        return _topUpStart[platform];
    }

    /// @notice End of the running top-up window, or 0 when the platform is not short or no clock runs.
    function topUpDeadline(address platform) public view returns (uint256) {
        uint256 req = _required[platform];
        if (req == 0 || _deposit[platform] >= req) return 0;
        uint256 start = _topUpStart[platform];
        if (start == 0) return 0;
        return start + _topUpWindow;
    }

    function openClaimsOf(address platform) external view returns (uint256) {
        return _openClaims[platform];
    }

    function exitRequestedAt(address platform) external view returns (uint64) {
        return _exitRequestedAt[platform];
    }

    /// @notice Derived on every read: a requirement exists, and the deposit meets it or the platform
    ///         is still inside its top-up window.
    function inGoodStanding(address platform) external view returns (bool) {
        uint256 req = _required[platform];
        if (req == 0) return false;
        if (_deposit[platform] >= req) return true;
        uint256 deadline = topUpDeadline(platform);
        return deadline != 0 && block.timestamp <= deadline;
    }

    // =================================================================== internal

    function _startClock(address platform) private {
        _topUpStart[platform] = uint64(block.timestamp);
        emit TopUpClockStarted(platform, block.timestamp + _topUpWindow);
    }

    function _clearClock(address platform) private {
        if (_topUpStart[platform] != 0) {
            _topUpStart[platform] = 0;
            emit TopUpCleared(platform);
        }
    }

    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory ret) = usdc.call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (!_succeeded(ok, ret)) revert TransferFailed();
    }

    /// @dev A token call succeeded if it did not revert and returned true, or returned nothing from an
    ///      address that has code. A false return counts as failure.
    function _succeeded(bool ok, bytes memory ret) private view returns (bool) {
        if (!ok) return false;
        if (ret.length == 0) return usdc.code.length > 0;
        if (ret.length < 32) return false;
        return abi.decode(ret, (uint256)) == 1;
    }
}
