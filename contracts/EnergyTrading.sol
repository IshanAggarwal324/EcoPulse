// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract EnergyTrading {
    IERC20 public carbonCreditToken;

    struct EnergyListing {
        address seller;
        uint256 energyAmount; // generic units
        uint256 price; // in CarbonCredits
        bool active;
    }

    mapping(uint256 => EnergyListing) public listings;
    uint256 public nextListingId;

    event EnergyListed(uint256 listingId, address seller, uint256 energyAmount, uint256 price);
    event EnergyPurchased(uint256 listingId, address buyer, address seller, uint256 energyAmount, uint256 price);

    constructor(address _carbonCreditTokenAddress) {
        carbonCreditToken = IERC20(_carbonCreditTokenAddress);
    }

    function listEnergy(uint256 _energyAmount, uint256 _price) public {
        require(_energyAmount > 0, "Energy amount must be > 0");
        require(_price > 0, "Price must be > 0");

        listings[nextListingId] = EnergyListing({
            seller: msg.sender,
            energyAmount: _energyAmount,
            price: _price,
            active: true
        });

        emit EnergyListed(nextListingId, msg.sender, _energyAmount, _price);
        nextListingId++;
    }

    function purchaseEnergy(uint256 _listingId) public {
        EnergyListing storage listing = listings[_listingId];
        require(listing.active, "Listing is not active");
        require(listing.seller != msg.sender, "Cannot buy your own listing");

        uint256 price = listing.price;
        address seller = listing.seller;

        // Mark inactive before transfer to prevent reentrancy-like issues
        listing.active = false;

        // Transfer Carbon Credits from buyer to seller
        require(carbonCreditToken.transferFrom(msg.sender, seller, price), "Transfer failed");

        emit EnergyPurchased(_listingId, msg.sender, seller, listing.energyAmount, price);
    }
}
