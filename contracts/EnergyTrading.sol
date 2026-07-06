// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title EnergyTrading
/// @notice Peer-to-peer marketplace for energy listings settled in CarbonCredit tokens
/// @custom:security-contact security@ecopulse.example
/// @dev AUDIT REQUIRED (C8): Not formally audited. Do not deploy to mainnet without a
///      professional security review. See contracts/AUDIT_MANIFEST.json and SECURITY.md.
contract EnergyTrading is ReentrancyGuard, Pausable, Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable carbonCreditToken;

    enum ListingStatus {
        Active,
        Sold,
        Cancelled,
        Expired
    }

    /// Maximum lifetime of an expiring listing. Caps storage/bloat risk and
    /// keeps stale supply from distorting the order book indefinitely.
    uint256 public constant MAX_LISTING_DURATION = 90 days;
    /// Minimum lifetime for an explicitly-expiring listing (guards accidental
    /// zero-length listings that would expire in the same block).
    uint256 public constant MIN_LISTING_DURATION = 1 minutes;
    /// Maximum number of concurrently-active listings a single seller may hold.
    /// Bounds contract-storage griefing (never-expiring listings otherwise bloat
    /// storage at gas cost with no per-seller limit). Generous for normal use.
    uint256 public constant MAX_ACTIVE_LISTINGS_PER_SELLER = 256;

    struct EnergyListing {
        address seller;
        uint256 energyAmount;
        uint256 price;
        ListingStatus status;
        uint256 createdAt;
        // Sub-module 2.4.3 — listing expiration. 0 means "never expires"
        // (back-compat with listings created via listEnergy(amount, price)).
        uint256 expiresAt;
    }

    mapping(uint256 => EnergyListing) public listings;
    uint256 public nextListingId;

    /// @dev Active-listing counter per seller, kept in sync on list / full-fill /
    ///      cancel / expire to enforce MAX_ACTIVE_LISTINGS_PER_SELLER.
    mapping(address => uint256) public activeListingsCount;

    event EnergyListed(
        uint256 indexed listingId,
        address indexed seller,
        uint256 energyAmount,
        uint256 price
    );

    event EnergyListedWithExpiry(
        uint256 indexed listingId,
        address indexed seller,
        uint256 energyAmount,
        uint256 price,
        uint256 expiresAt
    );

    event EnergyPurchased(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 energyAmount,
        uint256 price
    );

    event ListingCancelled(uint256 indexed listingId, address indexed seller);

    /// Emitted when an expired listing is pruned (Sub-module 2.4.3). Callable by
    /// anyone once past expiry so the marketplace is self-cleaning without
    /// requiring seller action or admin intervention.
    event ListingExpired(uint256 indexed listingId, address indexed seller);

    error InvalidTokenAddress();
    error InvalidAmount();
    error InvalidPrice();
    error InvalidDuration();
    error ListingNotActive();
    error NotListingSeller();
    error CannotBuyOwnListing();
    error ListingNotFound();
    error ListingExpiredStatus();
    error FillExceedsRemaining();
    error TooManyActiveListings();

    constructor(address carbonCreditTokenAddress) Ownable(msg.sender) {
        if (carbonCreditTokenAddress == address(0)) {
            revert InvalidTokenAddress();
        }
        carbonCreditToken = IERC20(carbonCreditTokenAddress);
    }

    /// @notice Pause all listing and purchase operations (owner only)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume marketplace operations (owner only)
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Create a new energy listing priced in CarbonCredits (never expires)
    function listEnergy(uint256 energyAmount, uint256 price) external whenNotPaused {
        if (energyAmount == 0) revert InvalidAmount();
        if (price == 0) revert InvalidPrice();
        _enforceListingCap(msg.sender);

        uint256 listingId = nextListingId;
        listings[listingId] = EnergyListing({
            seller: msg.sender,
            energyAmount: energyAmount,
            price: price,
            status: ListingStatus.Active,
            createdAt: block.timestamp,
            expiresAt: 0
        });

        emit EnergyListed(listingId, msg.sender, energyAmount, price);
        nextListingId++;
    }

    /// @notice Create an energy listing that auto-expires after `durationSeconds`
    /// (Sub-module 2.4.3). Stale supply is pruned automatically.
    function listEnergyWithExpiry(
        uint256 energyAmount,
        uint256 price,
        uint256 durationSeconds
    ) external whenNotPaused {
        if (energyAmount == 0) revert InvalidAmount();
        if (price == 0) revert InvalidPrice();
        if (durationSeconds < MIN_LISTING_DURATION || durationSeconds > MAX_LISTING_DURATION) {
            revert InvalidDuration();
        }
        _enforceListingCap(msg.sender);

        uint256 listingId = nextListingId;
        uint256 expiresAt = block.timestamp + durationSeconds;
        listings[listingId] = EnergyListing({
            seller: msg.sender,
            energyAmount: energyAmount,
            price: price,
            status: ListingStatus.Active,
            createdAt: block.timestamp,
            expiresAt: expiresAt
        });

        emit EnergyListedWithExpiry(listingId, msg.sender, energyAmount, price, expiresAt);
        nextListingId++;
    }

    /// @notice Cancel an active listing before it is purchased
    function cancelListing(uint256 listingId) external whenNotPaused {
        EnergyListing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
        if (!_isActive(listing)) revert ListingNotActive();
        if (listing.seller != msg.sender) revert NotListingSeller();

        listing.status = ListingStatus.Cancelled;
        activeListingsCount[msg.sender] -= 1;
        emit ListingCancelled(listingId, msg.sender);
    }

    /// @notice Purchase an entire active listing; transfers CarbonCredits buyer -> seller
    function purchaseEnergy(uint256 listingId) external nonReentrant whenNotPaused {
        EnergyListing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
        _purchase(listing, listingId, listing.energyAmount);
    }

    /// @notice Purchase a fraction of an active listing (Sub-module 2.4.3 partial
    /// fills). `energyAmount` may be less than the remaining amount; the listing
    /// stays Active with a reduced remaining amount until fully filled.
    function purchaseEnergyPartial(uint256 listingId, uint256 energyAmount)
        external
        nonReentrant
        whenNotPaused
    {
        EnergyListing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
        if (!_isActive(listing)) revert ListingNotActive();
        if (energyAmount == 0) revert InvalidAmount();
        if (energyAmount > listing.energyAmount) revert FillExceedsRemaining();
        _purchase(listing, listingId, energyAmount);
    }

    /// @dev Internal fill core shared by full + partial purchase. Assumes the
    /// caller has validated existence and (for partial) the fill bound.
    function _purchase(
        EnergyListing storage listing,
        uint256 listingId,
        uint256 buyAmount
    ) internal {
        if (!_isActive(listing)) revert ListingNotActive();
        if (listing.seller == msg.sender) revert CannotBuyOwnListing();

        // Proportional price for the filled portion. Integer division rounds
        // down in favor of the buyer; the remaining listing price is reduced by
        // exactly the charged amount so the seller is never shortchanged across
        // the full fill.
        uint256 remainingAmount = listing.energyAmount;
        uint256 remainingPrice = listing.price;
        uint256 fillPrice = (remainingPrice * buyAmount) / remainingAmount;

        address seller = listing.seller;

        listing.energyAmount = remainingAmount - buyAmount;
        listing.price = remainingPrice - fillPrice;

        if (listing.energyAmount == 0) {
            listing.status = ListingStatus.Sold;
            activeListingsCount[seller] -= 1;
        }

        carbonCreditToken.safeTransferFrom(msg.sender, seller, fillPrice);

        emit EnergyPurchased(listingId, msg.sender, seller, buyAmount, fillPrice);
    }

    /// @notice Returns whether a listing is currently open for purchase.
    /// Time-aware: expired listings read as inactive even before being pruned.
    function isListingActive(uint256 listingId) external view returns (bool) {
        EnergyListing storage listing = listings[listingId];
        return _isActive(listing);
    }

    function _isActive(EnergyListing storage listing) internal view returns (bool) {
        if (listing.seller == address(0)) return false;
        if (listing.status != ListingStatus.Active) return false;
        if (listing.expiresAt != 0 && block.timestamp >= listing.expiresAt) return false;
        return true;
    }

    /// @notice Prune an expired listing (Sub-module 2.4.3). Callable by anyone
    /// once the expiry timestamp has passed, keeping the marketplace
    /// self-cleaning. No reward — this is a public good call.
    function expireListing(uint256 listingId) external {
        EnergyListing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
        if (listing.status != ListingStatus.Active) revert ListingNotActive();
        if (listing.expiresAt == 0 || block.timestamp < listing.expiresAt) {
            revert ListingNotActive();
        }

        listing.status = ListingStatus.Expired;
        activeListingsCount[listing.seller] -= 1;
        emit ListingExpired(listingId, listing.seller);
    }

    /// @dev Enforces the per-seller active-listing cap before creating a listing.
    function _enforceListingCap(address seller) internal {
        if (activeListingsCount[seller] >= MAX_ACTIVE_LISTINGS_PER_SELLER) {
            revert TooManyActiveListings();
        }
        activeListingsCount[seller] += 1;
    }
}
