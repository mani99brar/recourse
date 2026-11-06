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
///
///         A platform's open claims are paid in filing order. Each claim states at filing the most it may be
///         owed (`maxPayoutOf`) and reserves it out of the deposit that no open claim may still be owed
///         (`depositOf - exposureOf`), so a later filing can never take what an open claim may be paid. A claim
///         whose payout is more than it may draw now waits (`EarlierClaimOpen`) while a claim filed before it
///         is still open; only the oldest open claim (`oldestOpenClaimOf`) ever closes short, and then only
///         because the deposit itself ran out. Anyone can end each earlier claim by its own frozen timeout at
///         the latest (expire it, close it after its window, or settle its ruling), so the wait is bounded, and
///         a later filing can neither extend it nor take what the waiting claim is owed.
/// @dev Invariants: `usdc.balanceOf(this) >= totalDeposits + totalEscrow + totalCredits`, with equality
///      unless someone transfers USDC to the vault directly (that excess is never counted or recoverable);
///      for every platform `reservedOf <= depositOf` and `reservedOf <= exposureOf`, the sums being those of
///      its open claims; and the open claims of a platform form one list in filing order.
///      Accounting never reads the token balance. No function accepts native value. No loop runs over claims.
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
    mapping(address platform => uint256) internal _reserved;
    mapping(bytes32 claimId => uint256) internal _reservation;
    /// @dev Sum of the open claims' `_maxPayout`, and each open claim's stated maximum.
    mapping(address platform => uint256) internal _exposure;
    mapping(bytes32 claimId => uint256) internal _maxPayout;
    /// @dev The platform's open claims as a doubly linked list in filing order (claim ids are never 0).
    mapping(address platform => bytes32) internal _oldest;
    mapping(address platform => bytes32) internal _newest;
    mapping(bytes32 claimId => bytes32) internal _prev;
    mapping(bytes32 claimId => bytes32) internal _next;

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
    /// @dev Stays callable after the lock; it changes standing only, never balances. As with a payout, the
    ///      top-up clock starts only when the new requirement takes a platform that met its old one below
    ///      it. A deposit that never met a requirement (a first partial deposit) starts none.
    function setRequired(address platform, uint256 amount) external onlyOwner {
        if (platform == address(0)) revert ZeroAddress();
        if (amount != 0 && amount < _minDeposit) revert BelowMinDeposit(amount, _minDeposit);
        uint256 prev = _required[platform];
        _required[platform] = amount;
        emit RequiredSet(platform, amount);

        uint256 held = _deposit[platform];
        if (amount == 0 || held >= amount) {
            _clearClock(platform);
        } else if (prev != 0 && held >= prev && _topUpStart[platform] == 0) {
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

    /// @notice Starts the caller's exit clock. New claims against the platform stay allowed until the exit
    ///         is due; the platform is out of good standing from the request on.
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

    /// @notice Withdraws the caller's pending exit request: claims can be filed against it again and its
    ///         standing is derived from its deposit again.
    function cancelExit() external {
        if (_exitRequestedAt[msg.sender] == 0) revert ExitNotRequested();
        _exitRequestedAt[msg.sender] = 0;
        emit ExitCancelled(msg.sender);
    }

    // =================================================================== claims contract only

    /// @notice Pulls `amount` from `shop` into a new escrow for `claimId`, stating a maximum payout of 0.
    function escrowFee(address shop, address platform, uint256 amount, bytes32 claimId)
        external
        onlyClaims
        nonReentrant
    {
        _escrowFee(shop, platform, amount, claimId, 0);
    }

    /// @notice Pulls `amount` from `shop` into a new escrow for `claimId`, records `maxPayout` as the most the
    ///         claim may be owed, and reserves for it up to `maxPayout` of the platform's deposit that no open
    ///         claim may still be owed (`depositOf - exposureOf`, before this claim).
    function escrowAndReserve(address shop, address platform, uint256 amount, bytes32 claimId, uint256 maxPayout)
        external
        onlyClaims
        nonReentrant
        returns (uint256 reserved)
    {
        reserved = _escrowFee(shop, platform, amount, claimId, maxPayout);
    }

    function _escrowFee(address shop, address platform, uint256 amount, bytes32 claimId, uint256 maxPayout)
        private
        returns (uint256 reserved)
    {
        if (!usdcAssociated) revert NotAssociatedYet();
        if (amount == 0) revert AmountZero();
        // Once a platform's exit is due, no new claim can keep it open; claims already open run out.
        uint256 exitAt = _exitRequestedAt[platform];
        if (exitAt != 0 && block.timestamp >= exitAt + _exitDelay) revert ExitDue();
        Escrow storage e = _escrows[claimId];
        if (e.state != EscrowState.None) revert EscrowExists(claimId);

        // Only what is beyond every open claim's stated maximum is free to reserve, so deposit an earlier claim
        // may still need (including deposit another claim just released) never goes to a later one.
        uint256 held = _deposit[platform];
        uint256 exposure = _exposure[platform];
        uint256 uncommitted = held > exposure ? held - exposure : 0;
        reserved = maxPayout < uncommitted ? maxPayout : uncommitted;
        _reserved[platform] += reserved;
        _reservation[claimId] = reserved;
        _exposure[platform] = exposure + maxPayout;
        _maxPayout[claimId] = maxPayout;
        _link(platform, claimId);

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

    /// @notice Closes `claimId`'s escrow. Pays `toShop` from the platform's deposit, capped at what the claim
    ///         may draw (`availableTo`), releases its reservation, refunds `refundToShop` of the escrow to the
    ///         shop and gives the rest of the escrow to the pool. Everything lands as credit; nothing is
    ///         transferred out here. When `toShop` is more than the claim may draw and it is not the oldest open
    ///         claim against the platform, nothing happens: it reverts `EarlierClaimOpen` and the claim waits.
    ///         The oldest open claim is never refused; its shortfall is final.
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
        uint256 available = _available(claimId, platform, held);
        if (toShop > available) {
            bytes32 oldest = _oldest[platform];
            if (oldest != claimId) revert EarlierClaimOpen(oldest);
        }
        _release(claimId, platform);
        paid = toShop < available ? toShop : available;
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

    function reservedOf(address platform) external view returns (uint256) {
        return _reserved[platform];
    }

    function reservationOf(bytes32 claimId) external view returns (uint256) {
        return _reservation[claimId];
    }

    function exposureOf(address platform) external view returns (uint256) {
        return _exposure[platform];
    }

    function maxPayoutOf(bytes32 claimId) external view returns (uint256) {
        return _maxPayout[claimId];
    }

    function oldestOpenClaimOf(address platform) external view returns (bytes32) {
        return _oldest[platform];
    }

    function availableTo(bytes32 claimId) external view returns (uint256) {
        Escrow storage e = _escrows[claimId];
        if (e.state != EscrowState.Open) return 0;
        return _available(claimId, e.platform, _deposit[e.platform]);
    }

    /// @notice Derived on every read: no exit is pending, a requirement exists, and the deposit meets it
    ///         or the platform is still inside its top-up window.
    function inGoodStanding(address platform) external view returns (bool) {
        if (_exitRequestedAt[platform] != 0) return false;
        uint256 req = _required[platform];
        if (req == 0) return false;
        if (_deposit[platform] >= req) return true;
        uint256 deadline = topUpDeadline(platform);
        return deadline != 0 && block.timestamp <= deadline;
    }

    // =================================================================== internal

    /// @dev What an open claim's payout may draw on now. Always its own reservation. The oldest open claim also
    ///      takes all of the unreserved deposit, since every other open claim was filed after it. Any other
    ///      claim takes only the unreserved deposit beyond what all other open claims may still be owed past
    ///      their own reservations, so it never takes what an earlier claim may need; if that is not enough it
    ///      waits until it is the oldest.
    function _available(bytes32 claimId, address platform, uint256 held) private view returns (uint256) {
        uint256 own = _reservation[claimId];
        uint256 reserved = _reserved[platform];
        uint256 unreserved = held - reserved;
        if (_oldest[platform] == claimId) return own + unreserved;
        uint256 othersUncovered = (_exposure[platform] - reserved) - (_maxPayout[claimId] - own);
        return own + (unreserved > othersUncovered ? unreserved - othersUncovered : 0);
    }

    /// @dev Releases the claim's reservation and stated maximum and takes it out of the filing-order list.
    function _release(bytes32 claimId, address platform) private {
        _reserved[platform] -= _reservation[claimId];
        _exposure[platform] -= _maxPayout[claimId];
        _reservation[claimId] = 0;
        _maxPayout[claimId] = 0;

        bytes32 prev = _prev[claimId];
        bytes32 next = _next[claimId];
        if (prev == bytes32(0)) _oldest[platform] = next;
        else _next[prev] = next;
        if (next == bytes32(0)) _newest[platform] = prev;
        else _prev[next] = prev;
        delete _prev[claimId];
        delete _next[claimId];
    }

    /// @dev Appends a newly opened claim to the platform's filing-order list.
    function _link(address platform, bytes32 claimId) private {
        bytes32 last = _newest[platform];
        if (last == bytes32(0)) {
            _oldest[platform] = claimId;
        } else {
            _next[last] = claimId;
            _prev[claimId] = last;
        }
        _newest[platform] = claimId;
    }

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
