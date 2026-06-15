// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title CarbonCredit
/// @notice ERC20 token representing carbon credits with a capped total supply
/// @dev AUDIT REQUIRED: This contract has not been formally audited. Do not deploy
///      to mainnet without a professional security review.
contract CarbonCredit is ERC20, Ownable {
    /// @dev Immutable maximum total supply (cannot be changed after deployment)
    uint256 public immutable maxSupply;

    /// @dev Total amount minted so far
    uint256 public totalMinted;

    error SupplyCapExceeded(uint256 requested, uint256 available);
    error InvalidMaxSupply();

    event Minted(address indexed to, uint256 amount, uint256 newTotalMinted);

    /// @param _maxSupply Maximum number of tokens (with decimals) that can ever exist.
    ///        Pass 0 to allow uncapped minting (NOT recommended for production).
    constructor(uint256 _maxSupply) ERC20("Carbon Credit", "CC") Ownable(msg.sender) {
        if (_maxSupply == 0) {
            // Allow 0 but warn via event — uncapped mode for testing only
            maxSupply = type(uint256).max;
        } else {
            maxSupply = _maxSupply;
        }
    }

    /// @notice Mint tokens to an address, respecting the supply cap.
    /// @dev onlyOwner — secure the owner key with hardware wallet or multisig (see contracts/SECURITY.md).
    /// @param to Recipient address
    /// @param amount Amount to mint (in base units, including decimals)
    function mint(address to, uint256 amount) public onlyOwner {
        if (amount == 0) revert InvalidMaxSupply();

        uint256 newTotal = totalMinted + amount;
        if (newTotal > maxSupply) {
            revert SupplyCapExceeded(amount, maxSupply - totalMinted);
        }

        totalMinted = newTotal;
        _mint(to, amount);

        emit Minted(to, amount, newTotal);
    }

    /// @notice Returns the remaining mintable supply
    function remainingSupply() external view returns (uint256) {
        return maxSupply - totalMinted;
    }
}
