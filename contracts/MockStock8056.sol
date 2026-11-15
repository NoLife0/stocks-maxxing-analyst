// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MockStock8056 — FALLBACK stock token (ERC-20 + ERC-8056 multiplier)
/// @notice This is the documented fallback from PHASE0.md §1: a hand-written
///         ERC-20 with ERC-8056 UI-multiplier semantics (`uiMultiplier`,
///         `balanceOfUI`, `updateUIMultiplier`), to be used ONLY if creating
///         real B20 Asset tokens through the Base factory precompile fails.
///         On Base Sepolia the B20 ASSET feature was live and both demo stocks
///         were created as genuine B20 tokens in Phase 1, so this contract is
///         kept in the repo as the contingency implementation and is NOT the
///         deployed instrument. See PHASE1.md for the deployment record.
contract MockStock8056 {
    string public name;
    string public symbol;
    uint8 public immutable decimals = 6;

    uint256 public totalSupply;
    address public owner;

    /// @notice ERC-8056 UI multiplier, WAD-scaled (1e18 = 1.0x).
    uint256 public uiMultiplier = 1e18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAt);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
        owner = msg.sender;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "to zero");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice ERC-8056: balance expressed in UI (share-equivalent) units.
    function balanceOfUI(address account) external view returns (uint256) {
        return (balanceOf[account] * uiMultiplier) / 1e18;
    }

    /// @notice Instant multiplier update (demo simplification of ERC-8056's
    ///         scheduled update; used to simulate dividends/splits).
    function updateUIMultiplier(uint256 newMultiplier) external onlyOwner {
        uint256 old = uiMultiplier;
        uiMultiplier = newMultiplier;
        emit UIMultiplierUpdated(old, newMultiplier, block.timestamp);
    }
}
