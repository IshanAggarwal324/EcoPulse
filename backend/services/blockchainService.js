const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// Load Environment Variables or use defaults for local Hardhat node
const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
const privateKey = process.env.PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Default hardhat account 0
const carbonCreditAddress = process.env.CARBON_CREDIT_ADDRESS;
const energyTradingAddress = process.env.ENERGY_TRADING_ADDRESS;

// Provide a provider and a wallet
const provider = new ethers.JsonRpcProvider(rpcUrl);
const baseWallet = new ethers.Wallet(privateKey, provider);
const wallet = new ethers.NonceManager(baseWallet);

const CARBON_CREDIT_ABI_FALLBACK = require('../constants/carbonCreditAbi');
const ENERGY_TRADING_ABI_FALLBACK = require('../constants/energyTradingAbi');

const loadArtifactAbi = (relativePath, fallback) => {
  try {
    const artifactPath = path.join(__dirname, '../../', relativePath);
    if (fs.existsSync(artifactPath)) {
      return JSON.parse(fs.readFileSync(artifactPath, 'utf8')).abi;
    }
  } catch (error) {
    console.warn(`Using bundled ABI fallback for ${relativePath}:`, error.message);
  }
  return fallback;
};

const carbonCreditAbi = loadArtifactAbi(
  'artifacts/contracts/CarbonCredit.sol/CarbonCredit.json',
  CARBON_CREDIT_ABI_FALLBACK
);
const energyTradingAbi = loadArtifactAbi(
  'artifacts/contracts/EnergyTrading.sol/EnergyTrading.json',
  ENERGY_TRADING_ABI_FALLBACK
);

class BlockchainService {
  static getCarbonCreditContract() {
    if (!carbonCreditAddress) throw new Error("CARBON_CREDIT_ADDRESS not configured in .env");
    return new ethers.Contract(carbonCreditAddress, carbonCreditAbi, wallet);
  }

  static getEnergyTradingContract() {
    if (!energyTradingAddress) throw new Error("ENERGY_TRADING_ADDRESS not configured in .env");
    return new ethers.Contract(energyTradingAddress, energyTradingAbi, wallet);
  }

  static getEnergyTradingContractReadOnly() {
    if (!energyTradingAddress) throw new Error("ENERGY_TRADING_ADDRESS not configured in .env");
    return new ethers.Contract(energyTradingAddress, energyTradingAbi, provider);
  }

  static async getActiveListings() {
    const contract = this.getEnergyTradingContractReadOnly();
    const nextId = Number(await contract.nextListingId());

    if (nextId === 0) {
      return [];
    }

    const listings = await Promise.all(
      Array.from({ length: nextId }, (_, i) => contract.listings(i))
    );

    const activeListings = [];

    listings.forEach((listing, i) => {
      const status = Number(listing.status ?? listing[3]);
      if (status !== 0) return;

      activeListings.push({
        id: i,
        seller: listing.seller,
        energyAmount: listing.energyAmount.toString(),
        price: ethers.formatEther(listing.price),
        createdAt: Number(listing.createdAt ?? listing[4]),
      });
    });

    return activeListings;
  }

  static async getListingById(listingId) {
    const contract = this.getEnergyTradingContractReadOnly();
    const listing = await contract.listings(listingId);
    const seller = listing.seller ?? listing[0];

    if (!seller || seller === ethers.ZeroAddress) {
      return null;
    }

    const status = Number(listing.status ?? listing[3]);
    const statusLabels = ['active', 'sold', 'cancelled'];

    return {
      id: Number(listingId),
      seller,
      energyAmount: (listing.energyAmount ?? listing[1]).toString(),
      price: ethers.formatEther(listing.price ?? listing[2]),
      status: statusLabels[status] || 'unknown',
      createdAt: Number(listing.createdAt ?? listing[4]),
      isActive: status === 0,
    };
  }

  /**
   * Mint Carbon Credits to a specified address
   * @param {string} toAddress
   * @param {string} amount (in string ether format, e.g., "100")
   */
  static async mintTokens(toAddress, amount) {
    const contract = this.getCarbonCreditContract();
    const tx = await contract.mint(toAddress, ethers.parseEther(amount));
    await tx.wait();
    return tx.hash;
  }

  /**
   * Get Carbon Credit Balance
   * @param {string} address
   */
  static async getBalance(address) {
    const contract = this.getCarbonCreditContract();
    const balance = await contract.balanceOf(address);
    return ethers.formatEther(balance);
  }

  static async getAllowance(ownerAddress, spenderAddress = energyTradingAddress) {
    const contract = this.getCarbonCreditContract();
    const allowance = await contract.allowance(ownerAddress, spenderAddress);
    return ethers.formatEther(allowance);
  }

  static async getTotalSupply() {
    const contract = this.getCarbonCreditContract();
    const supply = await contract.totalSupply();
    return ethers.formatEther(supply);
  }

  /**
   * List Energy for Trade
   * @param {number} energyAmount
   * @param {string} price (in string ether format)
   */
  static async listEnergy(energyAmount, price) {
    const contract = this.getEnergyTradingContract();
    const tx = await contract.listEnergy(energyAmount, ethers.parseEther(price));
    await tx.wait();
    return tx.hash;
  }

  /**
   * Purchase Energy
   * @param {number} listingId
   */
  static async purchaseEnergy(listingId) {
    const contract = this.getEnergyTradingContract();
    const tx = await contract.purchaseEnergy(listingId);
    await tx.wait();
    return tx.hash;
  }
  
  /**
   * Approve EnergyTrading contract to spend tokens
   * @param {string} amount 
   */
  static async approveTrading(amount) {
      const ccContract = this.getCarbonCreditContract();
      const tx = await ccContract.approve(energyTradingAddress, ethers.parseEther(amount));
      await tx.wait();
      return tx.hash;
  }
}

module.exports = BlockchainService;
