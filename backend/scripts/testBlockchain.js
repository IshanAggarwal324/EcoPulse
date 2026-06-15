const { ethers } = require('ethers');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { requireDevScript } = require('./utils/requireDevScript');
const BlockchainService = require('../services/blockchainService');

requireDevScript('testBlockchain');

async function run() {
  console.log('Starting Blockchain Service Test...');
  try {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'http://127.0.0.1:8545');
    const network = await provider.getNetwork();
    console.log('Connected to network:', network.chainId);

    const testAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

    console.log('Attempting to get balance...');
    const initialBalance = await BlockchainService.getBalance(testAddress);
    console.log('Initial Balance:', initialBalance, 'CC');

    console.log('Minting 50 CC to Test Address...');
    const mintHash = await BlockchainService.mintTokens(testAddress, '50');
    console.log('Mint Tx Hash:', mintHash);

    const newBalance = await BlockchainService.getBalance(testAddress);
    console.log('New Balance:', newBalance, 'CC');

    console.log('Approving EnergyTrading to spend 10 CC...');
    const approveHash = await BlockchainService.approveTrading('10');
    console.log('Approve Tx Hash:', approveHash);

    console.log('Listing Energy for Trade (100 units for 10 CC)...');
    const listHash = await BlockchainService.listEnergy(100, '10');
    console.log('List Tx Hash:', listHash);

    console.log('Blockchain Service tests executed successfully!');
  } catch (error) {
    console.error('Test Failed:', error.message);
    console.log('\n--- Troubleshooting ---');
    console.log('1. Set ALLOW_DEV_SCRIPTS=true in backend/.env');
    console.log('2. Ensure Hardhat local node is running: `npx hardhat node` in the root folder.');
    console.log('3. Deploy contracts: `npx hardhat ignition deploy ./ignition/modules/EnergySystem.js --network localhost`');
    console.log('4. Add deployed contract addresses and PRIVATE_KEY to backend/.env');
    process.exit(1);
  }
}

run();
