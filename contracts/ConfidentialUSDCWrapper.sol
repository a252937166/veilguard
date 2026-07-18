// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC20ToERC7984Wrapper} from "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";

/// @notice Sepolia cUSDC: the official ERC-20 -> ERC-7984 wrapper around
/// TestUSDC. Anyone can `wrap(to, amount)` after approving the underlying;
/// balances and transfers of the wrapped token are confidential.
contract ConfidentialUSDCWrapper is ERC20ToERC7984Wrapper {
    constructor(IERC20 underlying)
        ERC20ToERC7984Wrapper("Confidential USD Coin", "cUSDC", "", underlying)
    {}
}
