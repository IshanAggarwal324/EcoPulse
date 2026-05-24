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

// Load ABIs
let carbonCreditAbi = [];
let energyTradingAbi = [];

try {
  const ccPath = path.join(__dirname, "../../artifacts/contracts/CarbonCredit.sol/CarbonCredit.json");
  const etPath = path.join(__dirname, "../../artifacts/contracts/EnergyTrading.sol/EnergyTrading.json");
  
  if (fs.existsSync(ccPath)) {
    carbonCreditAbi = JSON.parse(fs.readFileSync(ccPath, "utf8")).abi;
  }
  if (fs.existsSync(etPath)) {
    energyTradingAbi = JSON.parse(fs.readFileSync(etPath, "utf8")).abi;
  }
} catch (error) {
  console.error("Error loading ABIs:", error.message);
}

class BlockchainService {
  static getCarbonCreditContract() {
    if (!carbonCreditAddress) throw new Error("CARBON_CREDIT_ADDRESS not configured in .env");
    return new ethers.Contract(carbonCreditAddress, carbonCreditAbi, wallet);
  }

  static getEnergyTradingContract() {
    if (!energyTradingAddress) throw new Error("ENERGY_TRADING_ADDRESS not configured in .env");
    return new ethers.Contract(energyTradingAddress, energyTradingAbi, wallet);
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
