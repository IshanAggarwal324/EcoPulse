const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { getRpcUrl } = require('../config/serviceUrls');

// Load environment variables. Never fall back to known dev private keys.
const rpcUrl = getRpcUrl();
const privateKey = process.env.PRIVATE_KEY || "";
const carbonCreditAddress = process.env.CARBON_CREDIT_ADDRESS;
const energyTradingAddress = process.env.ENERGY_TRADING_ADDRESS;

// Provide a provider; signer wallet is created lazily only for write operations.
const provider = new ethers.JsonRpcProvider(rpcUrl);

const getSignerWallet = () => {
  if (!privateKey) {
    throw new Error("PRIVATE_KEY not configured. Write blockchain operations are disabled.");
  }
  const baseWallet = new ethers.Wallet(privateKey, provider);
  return new ethers.NonceManager(baseWallet);
};

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
    return new ethers.Contract(carbonCreditAddress, carbonCreditAbi, getSignerWallet());
  }

  static getEnergyTradingContract() {
    if (!energyTradingAddress) throw new Error("ENERGY_TRADING_ADDRESS not configured in .env");
    return new ethers.Contract(energyTradingAddress, energyTradingAbi, getSignerWallet());
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

      const expiresAtRaw = listing.expiresAt ?? listing[5] ?? 0;
      const expiresAt = Number(expiresAtRaw);
      // Sub-module 2.4.3 — drop expired-but-not-yet-pruned listings from the
      // live order book so they don't inflate supply/depth metrics.
      if (expiresAt > 0 && Math.floor(Date.now() / 1000) >= expiresAt) return;

      activeListings.push({
        id: i,
        seller: listing.seller,
        energyAmount: listing.energyAmount.toString(),
        price: ethers.formatEther(listing.price),
        createdAt: Number(listing.createdAt ?? listing[4]),
        expiresAt: expiresAt > 0 ? expiresAt : null,
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
    const statusLabels = ['active', 'sold', 'cancelled', 'expired'];

    const expiresAtRaw = listing.expiresAt ?? listing[5] ?? 0;
    const expiresAt = Number(expiresAtRaw);
    const isExpired = expiresAt > 0 && Math.floor(Date.now() / 1000) >= expiresAt;

    return {
      id: Number(listingId),
      seller,
      energyAmount: (listing.energyAmount ?? listing[1]).toString(),
      price: ethers.formatEther(listing.price ?? listing[2]),
      status: isExpired && status === 0 ? 'expired' : statusLabels[status] || 'unknown',
      createdAt: Number(listing.createdAt ?? listing[4]),
      expiresAt: expiresAt > 0 ? expiresAt : null,
      isActive: status === 0 && !isExpired,
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
   * List Energy with an auto-expiry (Sub-module 2.4.3). Stale supply is pruned
   * from the order book once the duration elapses.
   * @param {number} energyAmount
   * @param {string} price (in string ether format)
   * @param {number} durationSeconds (clamped by the contract to [1m, 90d])
   */
  static async listEnergyWithExpiry(energyAmount, price, durationSeconds) {
    const contract = this.getEnergyTradingContract();
    const tx = await contract.listEnergyWithExpiry(
      energyAmount,
      ethers.parseEther(price),
      durationSeconds,
    );
    await tx.wait();
    return tx.hash;
  }

  /**
   * @notice Prune an expired listing on-chain (Sub-module 2.4.3). Callable by
   * the deployer/relayer wallet; anyone may call it on-chain directly too.
   */
  static async expireListing(listingId) {
    const contract = this.getEnergyTradingContract();
    const tx = await contract.expireListing(listingId);
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
   * Purchase a fraction of a listing (Sub-module 2.4.3 partial fills).
   * @param {number} listingId
   * @param {number} energyAmount amount to fill (must be <= remaining)
   */
  static async purchaseEnergyPartial(listingId, energyAmount) {
    const contract = this.getEnergyTradingContract();
    const tx = await contract.purchaseEnergyPartial(listingId, energyAmount);
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

  /**
   * Emergency stop (2.4 guardrail): pause all marketplace writes. Owner-only on
   * the contract; the deployer wallet (PRIVATE_KEY) is the contract owner.
   */
  static async pauseMarketplace() {
    const contract = this.getEnergyTradingContract();
    const tx = await contract.pause();
    await tx.wait();
    return tx.hash;
  }

  static async unpauseMarketplace() {
    const contract = this.getEnergyTradingContract();
    const tx = await contract.unpause();
    await tx.wait();
    return tx.hash;
  }

  static async isMarketplacePaused() {
    const contract = this.getEnergyTradingContractReadOnly();
    return Boolean(await contract.paused());
  }
}

module.exports = BlockchainService;
