// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20Mini2 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title SimpleRouter — fixed-reference-price USDC -> stock swap for the demo
/// @notice Sells stock tokens from its own inventory at an owner-set reference
///         price. The price is a DEMO reference (the operator sets it from the
///         mainnet Tokenized Stocks API NAV at setup time); this contract does
///         NOT pretend to read a live oracle. Research data shown to clients
///         always comes from the live mainnet API in the server, never from
///         this router. Assumes stock tokens use 6 decimals (as created).
contract SimpleRouter {
    address public owner;
    IERC20Mini2 public immutable usdc;

    /// @notice USDC per 1.0 share, scaled by 1e6 (e.g. $160.77 -> 160770000).
    mapping(address => uint256) public priceUsdcPerShare;

    event PriceSet(address indexed asset, uint256 priceUsdcPerShare);
    event Buy(address indexed buyer, address indexed asset, uint256 usdcIn, uint256 stockOut, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _usdc) {
        owner = msg.sender;
        usdc = IERC20Mini2(_usdc);
    }

    function setPrice(address asset, uint256 price) external onlyOwner {
        require(price > 0, "price zero");
        priceUsdcPerShare[asset] = price;
        emit PriceSet(asset, price);
    }

    /// @notice Buy stock with USDC at the reference price.
    /// @return stockOut Amount of stock token sent to `to` (6-decimal units).
    function buy(address asset, uint256 usdcAmount, address to) external returns (uint256 stockOut) {
        uint256 price = priceUsdcPerShare[asset];
        require(price > 0, "no price");
        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "usdc transferFrom failed");
        stockOut = (usdcAmount * 1e6) / price;
        require(stockOut > 0, "dust");
        require(IERC20Mini2(asset).balanceOf(address(this)) >= stockOut, "insufficient inventory");
        require(IERC20Mini2(asset).transfer(to, stockOut), "stock transfer failed");
        emit Buy(msg.sender, asset, usdcAmount, stockOut, to);
    }
}
