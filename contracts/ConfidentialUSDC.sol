// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Nox, euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {ERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/token/ERC7984.sol";

/// @notice Confidential USD Coin used by the local test-suite: a plain ERC-7984
/// with owner-controlled minting. The Sepolia deployment swaps this for the
/// official ERC-20 -> ERC-7984 wrapper around TestUSDC so the wrap/unwrap flow
/// is real; policy logic in VeilGuardModule only depends on the IERC7984
/// surface and works with either.
contract ConfidentialUSDC is ERC7984, Ownable {
    constructor()
        ERC7984("Confidential USD Coin", "cUSDC", "")
        Ownable(msg.sender)
    {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint tokens to `to` with an encrypted amount.
    function mint(
        address to,
        externalEuint256 encryptedAmount,
        bytes calldata inputProof
    ) external onlyOwner returns (euint256) {
        euint256 amount = Nox.fromExternal(encryptedAmount, inputProof);
        return _mint(to, amount);
    }
}
