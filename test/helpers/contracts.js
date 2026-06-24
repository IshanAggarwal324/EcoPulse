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

module.exports = {
  DEFAULT_MAX_SUPPLY,
  DEFAULT_MAX_MINT_PER_TX,
  DEFAULT_DISPUTE_WINDOW,
  deployCarbonCredit,
  deployEnergyTrading,
  deployEscrowSystem,
};
