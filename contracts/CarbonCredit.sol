// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IRetirementRegistry.sol";

/// @title CarbonCredit
/// @notice ERC20 token representing carbon credits with a capped total supply
/// @custom:security-contact security@ecopulse.example
/// @dev AUDIT REQUIRED (C8): This contract has NOT completed a professional third-party
///      audit. Do NOT deploy to mainnet until AUDIT_MANIFEST.json status is "audited"
///      and predeploy checks pass. See contracts/SECURITY.md.
/// @dev TODO(L7): Govern minting via multisig/DAO oracle — see P2P_Trading_Production_Readiness.md §1.
contract CarbonCredit is ERC20, AccessControl, ReentrancyGuard {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @dev Module 5.3.1 — Retirement. Plan suggested a `tokenId` in the Retired
    ///      event, but CarbonCredit is a fungible ERC20 (no token ids). We use a
    ///      monotonic `retirementId` instead — the production-correct identifier
    ///      for fungible credit retirements, and the key into RetirementRegistry.
    uint256 public totalRetired;
    uint256 public totalRetirements;
    mapping(address => uint256) public retiredByAccount;

    /// @dev Optional on-chain retirement ledger. address(0) disables registry
    ///      recording (retire still burns + emits). Linked post-deploy by admin.
    address public retirementRegistry;

    /// @dev Caps certificate URI length to bound calldata gas and storage cost
    ///      (anti gas-grief). 256 bytes is ample for an IPFS/HTTPS URI.
    uint256 public constant MAX_CERTIFICATE_URI_LENGTH = 256;

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
    error ZeroBurnAmount();
    error CertificateUriTooLong(uint256 length, uint256 max);

    event Minted(address indexed to, uint256 amount, uint256 newTotalMinted, address indexed minter);
    event MinterGranted(address indexed account, address indexed admin);
    event MinterRevoked(address indexed account, address indexed admin);

    /// @dev Emitted for any burn path (plain burn, burnFrom, retire, retireFrom).
    event Burned(address indexed account, uint256 amount, address indexed caller);

    /// @dev Emitted on retirement. retirementId is the fungible equivalent of a
    ///      certificate id and is the key into RetirementRegistry.
    event Retired(
        address indexed account,
        uint256 amount,
        uint256 indexed retirementId,
        string certificateUri,
        address indexed initiator
    );
    event RetirementRegistrySet(address indexed oldRegistry, address indexed newRegistry);

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

    /// @notice Link (or unlink with address(0)) the on-chain retirement ledger.
    /// @dev Admin-only. Callable while paused so wiring can be repaired in an
    ///      emergency, mirroring the escrow ⇄ dispute link pattern.
    function setRetirementRegistry(address newRegistry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address old = retirementRegistry;
        retirementRegistry = newRegistry;
        emit RetirementRegistrySet(old, newRegistry);
    }

    /// @notice Burn a portion of the caller's own balance.
    function burn(uint256 amount) external {
        if (amount == 0) revert ZeroBurnAmount();
        _burn(msg.sender, amount);
        emit Burned(msg.sender, amount, msg.sender);
    }

    /// @notice Burn on behalf of an account, consuming its allowance (like
    ///         ERC20Burnable). Allowance is decremented by `amount`.
    function burnFrom(address account, uint256 amount) external {
        if (amount == 0) revert ZeroBurnAmount();
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
        emit Burned(account, amount, msg.sender);
    }

    /// @notice Retire (burn) a portion of the caller's own credits, issuing a
    ///         retirement certificate and optionally recording it on-chain.
    /// @param amount CC tokens (raw) to retire. Must be > 0 and ≤ balance.
    /// @param certificateUri Off-chain certificate URI (IPFS/HTTPS), ≤ 256 bytes.
    /// @return retirementId Monotonic id for this retirement.
    function retire(uint256 amount, string calldata certificateUri)
        external
        nonReentrant
        returns (uint256)
    {
        return _retire(msg.sender, amount, certificateUri, msg.sender);
    }

    /// @notice Retire on behalf of an account, consuming its allowance.
    function retireFrom(address account, uint256 amount, string calldata certificateUri)
        external
        nonReentrant
        returns (uint256)
    {
        if (amount == 0) revert ZeroBurnAmount();
        _spendAllowance(account, msg.sender, amount);
        return _retire(account, amount, certificateUri, msg.sender);
    }

    /// @dev Shared retirement core. Effects (counters + burn) are applied before
    ///      the optional external registry call (CEI). `nonReentrant` on the
    ///      public wrappers guards against a malicious registry re-entering.
    function _retire(address account, uint256 amount, string calldata certificateUri, address initiator)
        internal
        returns (uint256 retirementId)
    {
        if (amount == 0) revert ZeroBurnAmount();
        uint256 uriLen = bytes(certificateUri).length;
        if (uriLen > MAX_CERTIFICATE_URI_LENGTH) {
            revert CertificateUriTooLong(uriLen, MAX_CERTIFICATE_URI_LENGTH);
        }

        retirementId = totalRetirements;
        totalRetirements = retirementId + 1;
        totalRetired += amount;
        retiredByAccount[account] += amount;

        _burn(account, amount);

        address registry = retirementRegistry;
        if (registry != address(0)) {
            IRetirementRegistry(registry).record(account, amount, retirementId, certificateUri, initiator);
        }

        emit Retired(account, amount, retirementId, certificateUri, initiator);
    }
}
