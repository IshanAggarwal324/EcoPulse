// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Minimal token surface the bridge relies on.
interface IBridgeToken {
    function mint(address to, uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
}

/// @title CarbonCreditBridge
/// @notice Lock/mint carbon-credit bridge for cross-chain (or testnet) transfers.
///
///         Outbound: `lock()` takes the sender's CC into custody and emits
///         `Locked`; a relayer on the destination chain mints to the recipient.
///         Inbound:  a relayer calls `mintFor()` (idempotent, RELAYER_ROLE) to
///         credit CC minted under the bridge's MINTER_ROLE.
///         Return:   a holder burns bridged CC via `returnToSource()`; the
///         source-chain relayer releases the originally locked CC back via
///         `releaseBack()`. This closes the loop so no value is stranded.
///
/// @custom:security-contact security@ecopulse.example
/// @dev AUDIT REQUIRED (C8): Bridges are the most exploited contract class.
///      Hardening here: RELAYER_ROLE-gated mints/releases, one-time nonce
///      consumption (anti double-mint / double-release), Pausable, per-tx and
///      rolling 24h daily caps, same-chain rejection, supported-chain whitelist,
///      Checks-Effects-Interactions + ReentrancyGuard. Still requires a formal
///      audit + multisig relayer set before mainnet. See contracts/SECURITY.md.
contract CarbonCreditBridge is ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    /// @dev Operation tags used to namespace idempotency keys so a mint nonce
    ///      and a release nonce can never collide.
    uint8 private constant OP_MINT = 1;
    uint8 private constant OP_RELEASE = 2;

    IERC20 public immutable token;

    /// @notice Maximum CC movable in a single lock / mint / return.
    uint256 public immutable maxPerTx;
    /// @notice Maximum CC movable (locked or returned) per rolling 24h window.
    uint256 public immutable dailyCap;

    uint256 public nextLockId;
    uint256 public nextReturnId;
    uint256 public totalLockedIn;

    /// @dev Whitelist of chains the bridge will lock *to* (outbound).
    mapping(uint256 => bool) public supportedChains;
    /// @dev One-time consumption of (op, sourceChainId, nonce) — anti replay.
    mapping(bytes32 => bool) public processedNonces;
    /// @dev Rolling daily locked volume keyed by day bucket (block.timestamp / 1 days).
    mapping(uint256 => uint256) public dailyLocked;

    event Locked(
        uint256 indexed lockId,
        address indexed sender,
        address recipient,
        uint256 amount,
        uint256 indexed targetChainId
    );
    event Minted(
        uint256 indexed nonce,
        address indexed recipient,
        uint256 amount,
        uint256 indexed sourceChainId,
        address relayer
    );
    event ReturnedToSource(
        uint256 indexed returnId,
        address indexed sender,
        uint256 amount,
        uint256 indexed sourceChainId
    );
    event Released(
        uint256 indexed returnId,
        address indexed recipient,
        uint256 amount,
        uint256 indexed sourceChainId,
        address relayer
    );
    event SupportedChainSet(uint256 indexed chainId, bool enabled);
    event DailyCapConsumed(uint256 indexed dayBucket, uint256 consumed);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroLimit();
    error UnsupportedChain(uint256 chainId);
    error SameChainBridge();
    error ExceedsPerTxCap(uint256 requested, uint256 cap);
    error ExceedsDailyCap(uint256 requested, uint256 remaining);
    error NonceAlreadyProcessed();
    error DailyCapConfigTooSmall();

    /// @param token_   CarbonCredit (or a wrapped equivalent) the bridge custodies/mints.
    /// @param _maxPerTx Per-transaction cap. Must be > 0 and ≤ dailyCap.
    /// @param _dailyCap Rolling 24h cap on outbound volume. Must be ≥ maxPerTx.
    /// @param admin    Receives DEFAULT_ADMIN_ROLE + RELAYER_ROLE (move relayer to a
    ///                 multisig / separate key set before mainnet).
    constructor(address token_, uint256 _maxPerTx, uint256 _dailyCap, address admin) {
        if (token_ == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        if (_maxPerTx == 0) revert ZeroLimit();
        if (_dailyCap == 0) revert ZeroLimit();
        if (_dailyCap < _maxPerTx) revert DailyCapConfigTooSmall();

        token = IERC20(token_);
        maxPerTx = _maxPerTx;
        dailyCap = _dailyCap;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, admin);
    }

    // ----------------------------------------------------------------- admin

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function setSupportedChain(uint256 chainId, bool enabled)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (chainId == 0) revert UnsupportedChain(chainId);
        supportedChains[chainId] = enabled;
        emit SupportedChainSet(chainId, enabled);
    }

    function grantRelayer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        _grantRole(RELAYER_ROLE, account);
    }

    function revokeRelayer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(RELAYER_ROLE, account);
    }

    // ---------------------------------------------------------------- outbound

    /// @notice Lock CC to be bridged to `targetChainId` for `recipient`.
    /// @dev Custody model: tokens are pulled from the sender (approve required).
    function lock(uint256 amount, uint256 targetChainId, address recipient)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (targetChainId == block.chainid) revert SameChainBridge();
        if (!supportedChains[targetChainId]) revert UnsupportedChain(targetChainId);

        uint256 cap = maxPerTx;
        if (amount > cap) revert ExceedsPerTxCap(amount, cap);

        uint256 dayBucket = block.timestamp / 1 days;
        uint256 used = dailyLocked[dayBucket];
        uint256 capDay = dailyCap;
        if (used + amount > capDay) {
            revert ExceedsDailyCap(amount, capDay > used ? capDay - used : 0);
        }
        dailyLocked[dayBucket] = used + amount;
        totalLockedIn += amount;
        emit DailyCapConsumed(dayBucket, used + amount);

        uint256 lockId = nextLockId;
        nextLockId = lockId + 1;

        // Effects recorded before the interaction (CEI).
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(lockId, msg.sender, recipient, amount, targetChainId);
    }

    /// @notice Burn bridged CC to retrieve the originally locked CC on the source
    ///         chain. Emits `ReturnedToSource`; a relayer there calls `releaseBack`.
    function returnToSource(uint256 amount, uint256 sourceChainId)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        if (sourceChainId == block.chainid) revert SameChainBridge();

        uint256 cap = maxPerTx;
        if (amount > cap) revert ExceedsPerTxCap(amount, cap);

        // Count returns against the same daily cap to bound bridge throughput.
        uint256 dayBucket = block.timestamp / 1 days;
        uint256 used = dailyLocked[dayBucket];
        uint256 capDay = dailyCap;
        if (used + amount > capDay) {
            revert ExceedsDailyCap(amount, capDay > used ? capDay - used : 0);
        }
        dailyLocked[dayBucket] = used + amount;
        emit DailyCapConsumed(dayBucket, used + amount);

        uint256 returnId = nextReturnId;
        nextReturnId = returnId + 1;

        // Burn the bridged tokens (sender must approve the bridge). Burning
        // (not re-custodying) prevents double-counting across the two chains.
        IBridgeToken(address(token)).burnFrom(msg.sender, amount);

        emit ReturnedToSource(returnId, msg.sender, amount, sourceChainId);
    }

    // ----------------------------------------------------------------- inbound

    /// @notice Mint CC on this chain for an inbound bridge transfer.
    /// @dev RELAYER_ROLE only. `nonce` is unique per (sourceChainId, transfer)
    ///      and consumed exactly once — the primary defense against double-mint.
    function mintFor(address recipient, uint256 amount, uint256 sourceChainId, uint256 nonce)
        external
        onlyRole(RELAYER_ROLE)
        nonReentrant
        whenNotPaused
    {
        _ingest(recipient, amount, sourceChainId, nonce, OP_MINT);

        // Bridge must hold MINTER_ROLE on the token; the token enforces its own
        // supply cap and per-tx mint limit as defense-in-depth.
        IBridgeToken(address(token)).mint(recipient, amount);

        emit Minted(nonce, recipient, amount, sourceChainId, msg.sender);
    }

    /// @notice Release originally locked CC back to a holder who returned/burned
    ///         bridged CC on the other chain. RELAYER_ROLE only, idempotent.
    function releaseBack(address recipient, uint256 amount, uint256 sourceChainId, uint256 nonce)
        external
        onlyRole(RELAYER_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (recipient == address(0)) revert ZeroAddress();
        _ingest(recipient, amount, sourceChainId, nonce, OP_RELEASE);

        // Return custody of originally locked tokens.
        token.safeTransfer(recipient, amount);

        emit Released(nonce, recipient, amount, sourceChainId, msg.sender);
    }

    // ------------------------------------------------------------------ views

    function getBridgeBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function dailyRemaining() external view returns (uint256) {
        uint256 used = dailyLocked[block.timestamp / 1 days];
        return used >= dailyCap ? 0 : dailyCap - used;
    }

    // ---------------------------------------------------------------- internal

    /// @dev Shared idempotency + bounds check for inbound relayer operations.
    ///      Marks the nonce consumed BEFORE the external call (CEI).
    function _ingest(address recipient, uint256 amount, uint256 sourceChainId, uint256 nonce, uint8 op)
        internal
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (sourceChainId == block.chainid) revert SameChainBridge();
        if (amount > maxPerTx) revert ExceedsPerTxCap(amount, maxPerTx);

        bytes32 key = keccak256(abi.encodePacked(op, sourceChainId, nonce));
        if (processedNonces[key]) revert NonceAlreadyProcessed();
        processedNonces[key] = true;
    }
}
