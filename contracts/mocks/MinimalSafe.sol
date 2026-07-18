// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal local stand-in for a Safe smart account, faithful to the two
/// behaviours VeilGuard relies on:
///   1. enabled modules can execute calls that originate FROM the Safe address
///      (execTransactionFromModule*, operation 0 = CALL only), and
///   2. owner-approved transactions execute arbitrary calls from the Safe address
///      (threshold/signature collection is out of scope for local tests).
/// The Sepolia deployment uses the real Safe v1.4.1 with the official
/// Transaction Service; this contract exists so the Nox ACL mechanics can be
/// exercised on the local stack with the exact same call-chain addresses.
contract MinimalSafe {
    mapping(address => bool) public isOwner;
    mapping(address => bool) public isModule;
    address[] private ownerList;

    event EnabledModule(address module);
    event DisabledModule(address module);

    constructor(address[] memory owners_) {
        require(owners_.length > 0, "no owners");
        for (uint256 i = 0; i < owners_.length; i++) {
            isOwner[owners_[i]] = true;
            ownerList.push(owners_[i]);
        }
    }

    modifier onlyOwner() {
        require(isOwner[msg.sender], "not owner");
        _;
    }

    function enableModule(address module) external onlyOwner {
        isModule[module] = true;
        emit EnabledModule(module);
    }

    function disableModule(address module) external onlyOwner {
        isModule[module] = false;
        emit DisabledModule(module);
    }

    function getOwners() external view returns (address[] memory) {
        return ownerList;
    }

    /// Safe ModuleManager-compatible entrypoints (operation 0 = CALL only).
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external returns (bool success) {
        require(isModule[msg.sender], "GS104");
        require(operation == 0, "call only");
        (success, ) = to.call{value: value}(data);
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external returns (bool success, bytes memory returnData) {
        require(isModule[msg.sender], "GS104");
        require(operation == 0, "call only");
        (success, returnData) = to.call{value: value}(data);
    }

    /// Stand-in for an executed multisig transaction (local tests only).
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data
    ) external onlyOwner returns (bytes memory ret) {
        bool success;
        (success, ret) = to.call{value: value}(data);
        require(success, "safe exec failed");
    }
}
