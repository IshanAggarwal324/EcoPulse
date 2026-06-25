module.exports = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function mint(address to, uint256 amount) public',
  'function totalSupply() view returns (uint256)',
  // Module 5.3.1 — burn / retire lifecycle
  'function burn(uint256 amount) public',
  'function burnFrom(address account, uint256 amount) public',
  'function retire(uint256 amount, string certificateUri) public returns (uint256)',
  'function retireFrom(address account, uint256 amount, string certificateUri) public returns (uint256)',
  'function setRetirementRegistry(address newRegistry) public',
  'function totalRetired() view returns (uint256)',
  'function totalRetirements() view returns (uint256)',
  'function retiredByAccount(address account) view returns (uint256)',
  'function retirementRegistry() view returns (address)',
  'event Burned(address indexed account, uint256 amount, address indexed caller)',
  'event Retired(address indexed account, uint256 amount, uint256 indexed retirementId, string certificateUri, address indexed initiator)',
  'event RetirementRegistrySet(address indexed oldRegistry, address indexed newRegistry)',
];

