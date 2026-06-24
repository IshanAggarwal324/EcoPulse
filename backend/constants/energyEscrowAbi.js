/**
 * Bundled ABI for EnergyEscrow so production does not depend on repo-root
 * Hardhat artifacts. Matches contracts/EnergyEscrow.sol.
 */
module.exports = [
  'function createEscrow(uint256 listingId, address seller, uint256 amount)',
  'function confirmDelivery(uint256 escrowId)',
  'function release(uint256 escrowId)',
  'function openDispute(uint256 escrowId, bytes32 evidenceHash)',
  'function claimTimeoutRefund(uint256 escrowId)',
  'function executeResolution(uint256 escrowId, uint8 outcome, uint256 buyerShareBps)',
  'function setDisputeResolution(address newResolver)',
  'function pause()',
  'function unpause()',
  'function paused() view returns (bool)',
  'function disputeResolution() view returns (address)',
  'function disputeWindow() view returns (uint256)',
  'function carbonCreditToken() view returns (address)',
  'function nextEscrowId() view returns (uint256)',
  'function MIN_DISPUTE_WINDOW() view returns (uint256)',
  'function MAX_DISPUTE_WINDOW() view returns (uint256)',
  'function escrows(uint256) view returns (address buyer, address seller, uint256 amount, uint8 state, uint256 createdAt, uint256 deliveredAt)',
  'function getEscrow(uint256) view returns (address buyer, address seller, uint256 amount, uint8 state, uint256 createdAt, uint256 deliveredAt)',
  'event EscrowCreated(uint256 indexed escrowId, uint256 indexed listingId, address indexed buyer, address seller, uint256 amount)',
  'event DeliveryConfirmed(uint256 indexed escrowId, address indexed seller)',
  'event EscrowReleased(uint256 indexed escrowId, address indexed seller, uint256 amount)',
  'event EscrowRefunded(uint256 indexed escrowId, address indexed buyer, uint256 amount, string reason)',
  'event EscrowSplit(uint256 indexed escrowId, address buyer, uint256 buyerAmount, address seller, uint256 sellerAmount)',
  'event DisputeOpened(uint256 indexed escrowId, uint256 indexed disputeId, bytes32 evidenceHash)',
  'event DisputeResolutionSet(address indexed oldResolver, address indexed newResolver)',
];
