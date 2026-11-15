// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20Mini {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ISimpleRouter {
    function buy(address asset, uint256 usdcAmount, address to) external returns (uint256 stockOut);
}

/// @title TreasuryPolicy — owner-signed guardrails for the agent's treasury
/// @notice Holds the agent's x402 research revenue (the x402 server points
///         `payTo` here). The owner (the agent wallet) can sweep accumulated
///         USDC into allowlisted tokenized-stock positions through the router,
///         subject to a hard per-sweep cap enforced onchain. This contract is
///         the onchain half of the "policy engine"; the profit calculation
///         itself happens offchain in the server.
contract TreasuryPolicy {
    address public owner;
    IERC20Mini public immutable usdc;
    ISimpleRouter public router;

    uint256 public perSweepCap; // in USDC atomic units (6 decimals)
    mapping(address => bool) public allowlisted;

    uint256 public totalSwept;
    uint256 public sweepCount;

    event RouterSet(address router);
    event CapSet(uint256 perSweepCap);
    event AllowlistSet(address indexed asset, bool allowed);
    event Sweep(uint256 indexed sweepId, uint256 totalUsdc, uint256 timestamp);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _usdc) {
        owner = msg.sender;
        usdc = IERC20Mini(_usdc);
    }

    function setRouter(address _router) external onlyOwner {
        router = ISimpleRouter(_router);
        emit RouterSet(_router);
    }

    function setPerSweepCap(uint256 cap) external onlyOwner {
        perSweepCap = cap;
        emit CapSet(cap);
    }

    function setAllowlisted(address asset, bool allowed) external onlyOwner {
        allowlisted[asset] = allowed;
        emit AllowlistSet(asset, allowed);
    }

    function usdcBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Convert USDC held here into stock positions held here.
    /// @param assets      Allowlisted stock token addresses (parallel to amounts).
    /// @param usdcAmounts USDC amount to spend per asset.
    function sweep(address[] calldata assets, uint256[] calldata usdcAmounts)
        external
        onlyOwner
        returns (uint256 total)
    {
        require(assets.length == usdcAmounts.length, "length mismatch");
        require(address(router) != address(0), "router unset");
        for (uint256 i = 0; i < assets.length; i++) {
            require(allowlisted[assets[i]], "asset not allowlisted");
            total += usdcAmounts[i];
        }
        require(total > 0, "zero sweep");
        require(total <= perSweepCap, "cap exceeded");
        require(total <= usdc.balanceOf(address(this)), "insufficient usdc");

        for (uint256 i = 0; i < assets.length; i++) {
            require(usdc.approve(address(router), usdcAmounts[i]), "approve failed");
            router.buy(assets[i], usdcAmounts[i], address(this));
        }
        totalSwept += total;
        sweepCount += 1;
        emit Sweep(sweepCount, total, block.timestamp);
    }
}
