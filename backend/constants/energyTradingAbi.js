/**
 * Bundled ABI so Render/production does not depend on repo-root Hardhat artifacts.
 * Matches contracts/EnergyTrading.sol.
 */
module.exports = [
  'function listEnergy(uint256 energyAmount, uint256 price)',
  'function listEnergyWithExpiry(uint256 energyAmount, uint256 price, uint256 durationSeconds)',
  'function purchaseEnergy(uint256 listingId)',
  'function purchaseEnergyPartial(uint256 listingId, uint256 energyAmount)',
  'function cancelListing(uint256 listingId)',
  'function expireListing(uint256 listingId)',
  'function pause()',
  'function unpause()',
  'function paused() view returns (bool)',
  'function isListingActive(uint256 listingId) view returns (bool)',
  'function nextListingId() view returns (uint256)',
  'function MAX_LISTING_DURATION() view returns (uint256)',
  'function MIN_LISTING_DURATION() view returns (uint256)',
  'function listings(uint256) view returns (address seller, uint256 energyAmount, uint256 price, uint8 status, uint256 createdAt, uint256 expiresAt)',
  'event EnergyListed(uint256 indexed listingId, address indexed seller, uint256 energyAmount, uint256 price)',
  'event EnergyListedWithExpiry(uint256 indexed listingId, address indexed seller, uint256 energyAmount, uint256 price, uint256 expiresAt)',
  'event EnergyPurchased(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 energyAmount, uint256 price)',
  'event ListingCancelled(uint256 indexed listingId, address indexed seller)',
  'event ListingExpired(uint256 indexed listingId, address indexed seller)',
  'event Paused(address account)',
  'event Unpaused(address account)',
];
