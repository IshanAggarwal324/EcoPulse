// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title EnergyTrading
/// @notice Peer-to-peer marketplace for energy listings settled in CarbonCredit tokens
contract EnergyTrading is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable carbonCreditToken;

    enum ListingStatus {
        Active,
        Sold,
        Cancelled
    }

    struct EnergyListing {
        address seller;
        uint256 energyAmount;
        uint256 price;
        ListingStatus status;
        uint256 createdAt;
    }

    mapping(uint256 => EnergyListing) public listings;
    uint256 public nextListingId;

    event EnergyListed(
        uint256 indexed listingId,
        address indexed seller,
        uint256 energyAmount,
        uint256 price
    );

    event EnergyPurchased(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 energyAmount,
        uint256 price
    );

    event ListingCancelled(uint256 indexed listingId, address indexed seller);

    error InvalidTokenAddress();
    error InvalidAmount();
    error InvalidPrice();
    error ListingNotActive();
    error NotListingSeller();
    error CannotBuyOwnListing();
    error ListingNotFound();

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

    /// @notice Create a new energy listing priced in CarbonCredits
    function listEnergy(uint256 energyAmount, uint256 price) external whenNotPaused {
        if (energyAmount == 0) revert InvalidAmount();
        if (price == 0) revert InvalidPrice();

        uint256 listingId = nextListingId;
        listings[listingId] = EnergyListing({
            seller: msg.sender,
            energyAmount: energyAmount,
            price: price,
            status: ListingStatus.Active,
            createdAt: block.timestamp
        });

        emit EnergyListed(listingId, msg.sender, energyAmount, price);
        nextListingId++;
    }

    /// @notice Cancel an active listing before it is purchased
    function cancelListing(uint256 listingId) external whenNotPaused {
        EnergyListing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
        if (listing.status != ListingStatus.Active) revert ListingNotActive();
        if (listing.seller != msg.sender) revert NotListingSeller();

        listing.status = ListingStatus.Cancelled;
        emit ListingCancelled(listingId, msg.sender);
    }

    /// @notice Purchase an active listing; transfers CarbonCredits from buyer to seller
    function purchaseEnergy(uint256 listingId) external nonReentrant whenNotPaused {
        EnergyListing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
        if (listing.status != ListingStatus.Active) revert ListingNotActive();
        if (listing.seller == msg.sender) revert CannotBuyOwnListing();

        uint256 price = listing.price;
        address seller = listing.seller;
        uint256 energyAmount = listing.energyAmount;

        listing.status = ListingStatus.Sold;

        carbonCreditToken.safeTransferFrom(msg.sender, seller, price);

        emit EnergyPurchased(listingId, msg.sender, seller, energyAmount, price);
    }

    /// @notice Returns whether a listing is currently open for purchase
    function isListingActive(uint256 listingId) external view returns (bool) {
        EnergyListing storage listing = listings[listingId];
        return listing.seller != address(0) && listing.status == ListingStatus.Active;
    }
}
