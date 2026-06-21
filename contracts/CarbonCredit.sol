// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title CarbonCredit
/// @notice ERC20 token representing carbon credits with a capped total supply
/// @custom:security-contact security@ecopulse.example
/// @dev AUDIT REQUIRED (C8): This contract has NOT completed a professional third-party
///      audit. Do NOT deploy to mainnet until AUDIT_MANIFEST.json status is "audited"
///      and predeploy checks pass. See contracts/SECURITY.md.
contract CarbonCredit is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @dev On-chain marker for tooling / block explorers (update after formal audit + redeploy).
    string public constant AUDIT_STATUS = "UNAUDITED";

    /// @dev Immutable maximum total supply (must be > 0; uncapped deployment is forbidden).
    uint256 public immutable maxSupply;

    /// @dev Maximum tokens mintable in a single transaction (rate-limits operational minting).
    uint256 public immutable maxMintPerTx;

    /// @dev Total amount minted so far
    uint256 public totalMinted;

    error ZeroMaxSupply();
    error ZeroMaxMintPerTx();
    error ZeroMintAmount();
    error ZeroAddress();
    error SupplyCapExceeded(uint256 requested, uint256 available);
    error MintAmountExceedsLimit(uint256 requested, uint256 limit);

    event Minted(address indexed to, uint256 amount, uint256 newTotalMinted, address indexed minter);
    event MinterGranted(address indexed account, address indexed admin);
    event MinterRevoked(address indexed account, address indexed admin);

    /// @param _maxSupply Maximum number of tokens (with decimals) that can ever exist. Must be > 0.
    /// @param _maxMintPerTx Maximum mint size per transaction. Must be > 0 and <= _maxSupply.
    /// @param admin Receives DEFAULT_ADMIN_ROLE and initial MINTER_ROLE (transfer admin to multisig post-deploy).
    constructor(uint256 _maxSupply, uint256 _maxMintPerTx, address admin)
        ERC20("Carbon Credit", "CC")
    {
        if (_maxSupply == 0) revert ZeroMaxSupply();
        if (_maxMintPerTx == 0) revert ZeroMaxMintPerTx();
        if (_maxMintPerTx > _maxSupply) revert MintAmountExceedsLimit(_maxMintPerTx, _maxSupply);
        if (admin == address(0)) revert ZeroAddress();

        maxSupply = _maxSupply;
        maxMintPerTx = _maxMintPerTx;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mint tokens to an address, respecting the supply cap and per-tx limit.
    /// @dev Callable only by addresses with MINTER_ROLE. Grant MINTER_ROLE to an
    ///      operational hot wallet; keep DEFAULT_ADMIN_ROLE on a multisig (C9).
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroMintAmount();
        if (amount > maxMintPerTx) {
            revert MintAmountExceedsLimit(amount, maxMintPerTx);
        }

        uint256 newTotal = totalMinted + amount;
        if (newTotal > maxSupply) {
            revert SupplyCapExceeded(amount, maxSupply - totalMinted);
        }

        totalMinted = newTotal;
        _mint(to, amount);

        emit Minted(to, amount, newTotal, msg.sender);
    }

    /// @notice Grant minting rights to an operational wallet (admin / multisig only).
    function grantMinter(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        grantRole(MINTER_ROLE, account);
        emit MinterGranted(account, msg.sender);
    }

    /// @notice Revoke minting rights (admin / multisig only).
    function revokeMinter(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(MINTER_ROLE, account);
        emit MinterRevoked(account, msg.sender);
    }

    /// @notice Returns the remaining mintable supply
    function remainingSupply() external view returns (uint256) {
        return maxSupply - totalMinted;
    }
}
