/**
 * Bundled ABI so Render/production does not depend on repo-root Hardhat artifacts.
 * Matches contracts/EnergyTrading.sol.
 */
module.exports = [
  'function listEnergy(uint256 energyAmount, uint256 price)',
  'function purchaseEnergy(uint256 listingId)',
  'function cancelListing(uint256 listingId)',
  'function pause()',
  'function unpause()',
  'function paused() view returns (bool)',
  'function isListingActive(uint256 listingId) view returns (bool)',
  'function nextListingId() view returns (uint256)',
  'function listings(uint256) view returns (address seller, uint256 energyAmount, uint256 price, uint8 status, uint256 createdAt)',
  'event EnergyListed(uint256 indexed listingId, address indexed seller, uint256 energyAmount, uint256 price)',
  'event EnergyPurchased(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 energyAmount, uint256 price)',
  'event ListingCancelled(uint256 indexed listingId, address indexed seller)',
  'event Paused(address account)',
  'event Unpaused(address account)',
];
