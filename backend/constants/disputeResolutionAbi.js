/**
 * Bundled ABI for DisputeResolution so production does not depend on repo-root
 * Hardhat artifacts. Matches contracts/DisputeResolution.sol.
 */
module.exports = [
  'function openDispute(uint256 escrowId, address buyer, address seller, uint256 amount, bytes32 evidenceHash) returns (uint256)',
  'function resolve(uint256 disputeId, uint8 outcome, uint256 buyerShareBps)',
  'function disputes(uint256) view returns (uint256 escrowId, address buyer, address seller, uint256 amount, bytes32 evidenceHash, bool resolved, uint8 outcome, uint256 createdAt)',
  'function disputeCount() view returns (uint256)',
  'function ARBITER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function escrow() view returns (address)',
  'event DisputeOpened(uint256 indexed disputeId, uint256 indexed escrowId, address indexed buyer, address seller, uint256 amount, bytes32 evidenceHash)',
  'event DisputeResolved(uint256 indexed disputeId, uint256 indexed escrowId, uint8 outcome, uint256 buyerShareBps, address indexed arbiter)',
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
];
