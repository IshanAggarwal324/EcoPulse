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

module.exports = {
  DEFAULT_MAX_SUPPLY,
  DEFAULT_MAX_MINT_PER_TX,
  deployCarbonCredit,
  deployEnergyTrading,
};
