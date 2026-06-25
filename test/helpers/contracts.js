const { ethers } = require("hardhat");

const DEFAULT_MAX_SUPPLY = ethers.parseEther("1000000000");
const DEFAULT_MAX_MINT_PER_TX = ethers.parseEther("1000000");

/**
 * Deploy CarbonCredit with production-safe defaults for tests and scripts.
 */
async function deployCarbonCredit(deployer, options = {}) {
  const maxSupply = options.maxSupply ?? DEFAULT_MAX_SUPPLY;
  const maxMintPerTx = options.maxMintPerTx ?? DEFAULT_MAX_MINT_PER_TX;
  const admin = options.admin ?? deployer.address;

  const CarbonCredit = await ethers.getContractFactory("CarbonCredit");
  const carbonCredit = await CarbonCredit.deploy(maxSupply, maxMintPerTx, admin);
  await carbonCredit.waitForDeployment();

  if (options.grantMinterTo) {
    await carbonCredit.grantMinter(options.grantMinterTo);
    if (options.revokeDeployerMinter) {
      await carbonCredit.revokeMinter(admin);
    }
  }

  return carbonCredit;
}

async function deployEnergyTrading(carbonCreditAddress) {
  const EnergyTrading = await ethers.getContractFactory("EnergyTrading");
  const energyTrading = await EnergyTrading.deploy(carbonCreditAddress);
  await energyTrading.waitForDeployment();
  return energyTrading;
}

const DEFAULT_DISPUTE_WINDOW = 60n * 60n * 24n * 3n; // 3 days

/**
 * Deploy EnergyEscrow + DisputeResolution and wire them together. The escrow's
 * dispute-resolution link is set after construction to break the circular
 * constructor dependency (DisputeResolution needs the escrow address, the
 * escrow needs the dispute address).
 */
async function deployEscrowSystem(
  deployer,
  carbonCreditAddress,
  options = {},
) {
  const disputeWindow = options.disputeWindow ?? DEFAULT_DISPUTE_WINDOW;
  const admin = options.admin ?? deployer.address;

  const EnergyEscrow = await ethers.getContractFactory("EnergyEscrow");
  const escrow = await EnergyEscrow.deploy(carbonCreditAddress, disputeWindow);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();

  const DisputeResolution = await ethers.getContractFactory("DisputeResolution");
  const disputeResolution = await DisputeResolution.deploy(escrowAddr, admin);
  await disputeResolution.waitForDeployment();

  await escrow.setDisputeResolution(await disputeResolution.getAddress());

  return { escrow, disputeResolution, escrowAddr };
}

/**
 * Module 5.3.2 — deploy RetirementRegistry and link it into CarbonCredit so
 * retire() records on-chain. The link step is optional (linkToToken:false).
 */
async function deployRetirementRegistry(deployer, carbonCreditAddress, options = {}) {
  const admin = options.admin ?? deployer.address;
  const RetirementRegistry = await ethers.getContractFactory("RetirementRegistry");
  const registry = await RetirementRegistry.deploy(carbonCreditAddress, admin);
  await registry.waitForDeployment();

  if (options.linkToToken !== false) {
    const CarbonCredit = await ethers.getContractFactory("CarbonCredit");
    await CarbonCredit.attach(carbonCreditAddress).setRetirementRegistry(
      await registry.getAddress(),
    );
  }
  return registry;
}

const DEFAULT_BRIDGE_MAX_PER_TX = ethers.parseEther("100000");
const DEFAULT_BRIDGE_DAILY_CAP = ethers.parseEther("1000000");

/**
 * Module 5.3.3 — deploy CarbonCreditBridge. Optionally grants the bridge
 * MINTER_ROLE on the token (needed for inbound mintFor).
 */
async function deployBridge(deployer, carbonCreditAddress, options = {}) {
  const admin = options.admin ?? deployer.address;
  const maxPerTx = options.maxPerTx ?? DEFAULT_BRIDGE_MAX_PER_TX;
  const dailyCap = options.dailyCap ?? DEFAULT_BRIDGE_DAILY_CAP;

  const CarbonCreditBridge = await ethers.getContractFactory("CarbonCreditBridge");
  const bridge = await CarbonCreditBridge.deploy(carbonCreditAddress, maxPerTx, dailyCap, admin);
  await bridge.waitForDeployment();

  if (options.grantMinter !== false) {
    const CarbonCredit = await ethers.getContractFactory("CarbonCredit");
    await CarbonCredit.attach(carbonCreditAddress).grantMinter(await bridge.getAddress());
  }
  return bridge;
}

module.exports = {
  DEFAULT_MAX_SUPPLY,
  DEFAULT_MAX_MINT_PER_TX,
  DEFAULT_DISPUTE_WINDOW,
  DEFAULT_BRIDGE_MAX_PER_TX,
  DEFAULT_BRIDGE_DAILY_CAP,
  deployCarbonCredit,
  deployEnergyTrading,
  deployEscrowSystem,
  deployRetirementRegistry,
  deployBridge,
};
