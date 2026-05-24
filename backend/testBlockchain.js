const { ethers } = require("ethers");
require("dotenv").config();
const BlockchainService = require("./services/blockchainService");

async function run() {
  console.log("Starting Blockchain Service Test...");
  try {
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const network = await provider.getNetwork();
    console.log("Connected to network:", network.chainId);

    const testAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Account #1 in Hardhat default list

    console.log("Attempting to get balance...");
    const initialBalance = await BlockchainService.getBalance(testAddress);
    console.log("Initial Balance:", initialBalance, "CC");

    console.log("Minting 50 CC to Test Address...");
    const mintHash = await BlockchainService.mintTokens(testAddress, "50");
    console.log("Mint Tx Hash:", mintHash);

    const newBalance = await BlockchainService.getBalance(testAddress);
    console.log("New Balance:", newBalance, "CC");

    console.log("Approving EnergyTrading to spend 10 CC...");
    const approveHash = await BlockchainService.approveTrading("10");
    console.log("Approve Tx Hash:", approveHash);
    
    console.log("Listing Energy for Trade (100 units for 10 CC)...");
    const listHash = await BlockchainService.listEnergy(100, "10");
    console.log("List Tx Hash:", listHash);

    console.log("Blockchain Service tests executed successfully!");

  } catch (error) {
    console.error("Test Failed:", error.message);
    console.log("\n--- Troubleshooting ---");
    console.log("1. Ensure Hardhat local node is running: `npx hardhat node` in the root folder.");
    console.log("2. Deploy contracts to localhost: `npx hardhat ignition deploy ./ignition/modules/EnergySystem.js --network localhost`");
    console.log("3. Add the deployed contract addresses to backend/.env:");
    console.log("   CARBON_CREDIT_ADDRESS=0x...");
    console.log("   ENERGY_TRADING_ADDRESS=0x...");
  }
}

run();
