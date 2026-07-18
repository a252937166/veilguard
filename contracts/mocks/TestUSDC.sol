// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain ERC-20 used as the public underlying asset for the demo.
/// Anyone can mint themselves a capped amount per call (testnet faucet).
contract TestUSDC is ERC20 {
    uint256 public constant FAUCET_CAP = 10_000e6;

    constructor() ERC20("Test USD Coin", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(uint256 amount) external {
        require(amount <= FAUCET_CAP, "faucet: cap exceeded");
        _mint(msg.sender, amount);
    }
}
