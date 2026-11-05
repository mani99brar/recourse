// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title MockHtsUsdc (local tests and anvil only; never deployed to a live network)
/// @notice Stands in for the HTS USDC token's ERC-20 facade: 6 decimals, `approve`/`transferFrom`
///         with `msg.sender` as the spender, and HTS association rules. Moving tokens to or from an
///         account that is not associated fails: by default it reverts, and after
///         `setReturnFalse(true)` it returns false instead, as some facades do.
/// @dev Etch-safe: it has no constructor and reads no constructor-set storage, so it works when its
///      runtime code is copied to the facade address with `vm.etch` or `anvil_setCode`.
///      `mint`, `setReturnFalse` and the `mock*` helpers are open to anyone, which is fine only locally.
contract MockHtsUsdc {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error TokenNotAssociated(address account);
    error InsufficientBalance(address account, uint256 have, uint256 need);
    error InsufficientAllowance(address owner, address spender, uint256 have, uint256 need);

    int64 internal constant SUCCESS = 22;
    int64 internal constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public associatedAccount;
    uint256 public totalSupply;
    bool public returnFalseMode;

    function name() external pure returns (string memory) {
        return "USD Coin";
    }

    function symbol() external pure returns (string memory) {
        return "USDC";
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }

    // ------------------------------------------------------------ association (token side)

    function associate() external returns (uint256 responseCode) {
        return uint256(int256(_associate(msg.sender)));
    }

    function dissociate() external returns (uint256 responseCode) {
        associatedAccount[msg.sender] = false;
        return uint256(int256(SUCCESS));
    }

    function isAssociated() external view returns (bool) {
        return associatedAccount[msg.sender];
    }

    // ------------------------------------------------------------ test helpers

    /// @notice Marks `account` associated; returns the HTS response code it would get.
    function mockAssociate(address account) external returns (int64 responseCode) {
        return _associate(account);
    }

    function mockDissociate(address account) external {
        associatedAccount[account] = false;
    }

    function setReturnFalse(bool on) external {
        returnFalseMode = on;
    }

    /// @notice Faucet stand-in. Like the real faucet, it needs the receiver associated first.
    function mint(address to, uint256 amount) external {
        if (!associatedAccount[to]) revert TokenNotAssociated(to);
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    // ------------------------------------------------------------ ERC-20

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) {
            if (returnFalseMode) return false;
            revert InsufficientAllowance(from, msg.sender, allowed, amount);
        }
        if (!_canMove(from, to, amount)) return false;
        allowance[from][msg.sender] = allowed - amount;
        _apply(from, to, amount);
        return true;
    }

    // ------------------------------------------------------------ internal

    function _associate(address account) internal returns (int64) {
        if (associatedAccount[account]) return TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT;
        associatedAccount[account] = true;
        return SUCCESS;
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        if (!_canMove(from, to, amount)) return false;
        _apply(from, to, amount);
        return true;
    }

    /// @dev Returns false (false mode) or reverts (default) when the move is not allowed.
    function _canMove(address from, address to, uint256 amount) internal view returns (bool) {
        if (!associatedAccount[from]) {
            if (returnFalseMode) return false;
            revert TokenNotAssociated(from);
        }
        if (!associatedAccount[to]) {
            if (returnFalseMode) return false;
            revert TokenNotAssociated(to);
        }
        uint256 have = balanceOf[from];
        if (have < amount) {
            if (returnFalseMode) return false;
            revert InsufficientBalance(from, have, amount);
        }
        return true;
    }

    function _apply(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
