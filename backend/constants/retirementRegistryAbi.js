// Fallback (human-readable) ABI for RetirementRegistry (Module 5.3.2).
module.exports = [
  'function record(address retiree, uint256 amount, uint256 retirementId, string certificateUri, address initiator) public',
  'function attest(uint256 retirementId, string project, uint16 vintage, bytes32 nodeHash) public',
  'function getRetirement(uint256 retirementId) view returns ((address retiree, uint256 amount, string certificateUri, address initiator, string project, uint16 vintage, bytes32 nodeHash, uint256 timestamp, bool attested))',
  'function token() view returns (address)',
  'function totalRetired() view returns (uint256)',
  'function retiredByAccount(address account) view returns (uint256)',
  'function retirementCount() view returns (uint256)',
  'function ATTESTER_ROLE() view returns (bytes32)',
  'event Recorded(uint256 indexed retirementId, address indexed retiree, uint256 amount, address indexed initiator, string certificateUri)',
  'event Attested(uint256 indexed retirementId, address indexed attester, string project, uint16 vintage, bytes32 nodeHash)',
];
