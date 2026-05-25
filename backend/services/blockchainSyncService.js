const { ethers } = require('ethers');
const Trade = require('../models/Trade');
const BlockchainService = require('./blockchainService');

let isSyncing = false;

const parseEventTrade = (eventName, log, args) => {
  if (eventName === 'EnergyListed') {
    return {
      listingId: Number(args.listingId),
      eventType: 'listed',
      seller: args.seller,
      buyer: null,
      energyAmount: Number(args.energyAmount),
      price: ethers.formatEther(args.price),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      timestamp: new Date(),
    };
  }

  if (eventName === 'EnergyPurchased') {
    return {
      listingId: Number(args.listingId),
      eventType: 'purchased',
      seller: args.seller,
      buyer: args.buyer,
      energyAmount: Number(args.energyAmount),
      price: ethers.formatEther(args.price),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      timestamp: new Date(),
    };
  }

  return null;
};

const syncBlockchainTrades = async () => {
  if (isSyncing) {
    return { skipped: true, message: 'Sync already in progress' };
  }

  if (!process.env.ENERGY_TRADING_ADDRESS || !process.env.CARBON_CREDIT_ADDRESS) {
    return {
      skipped: true,
      message: 'Blockchain contracts not configured',
      indexed: 0,
      activeListings: 0,
    };
  }

  isSyncing = true;
  let indexed = 0;

  try {
    const contract = BlockchainService.getEnergyTradingContract();
    const provider = contract.runner.provider;
    const fromBlock = 0;
    const toBlock = await provider.getBlockNumber();

    const filters = [
      { name: 'EnergyListed', filter: contract.filters.EnergyListed() },
      { name: 'EnergyPurchased', filter: contract.filters.EnergyPurchased() },
    ];

    for (const { name, filter } of filters) {
      const logs = await contract.queryFilter(filter, fromBlock, toBlock);

      for (const log of logs) {
        const parsed = contract.interface.parseLog(log);
        const tradeData = parseEventTrade(name, log, parsed.args);

        if (!tradeData) continue;

        const existing = await Trade.findOne({ txHash: tradeData.txHash });
        if (existing) continue;

        await Trade.create(tradeData);
        indexed += 1;
      }
    }

    let activeListings = 0;
    try {
      const nextId = Number(await contract.nextListingId());
      for (let i = 0; i < nextId; i += 1) {
        const listing = await contract.listings(i);
        if (listing.active) activeListings += 1;
      }
    } catch {
      activeListings = 0;
    }

    return {
      indexed,
      activeListings,
      fromBlock,
      toBlock,
      syncedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      skipped: true,
      message: error.message,
      indexed: 0,
      activeListings: 0,
      syncedAt: new Date().toISOString(),
    };
  } finally {
    isSyncing = false;
  }
};

const getChainStatus = async () => {
  try {
    const contract = BlockchainService.getEnergyTradingContract();
    const provider = contract.runner.provider;
    const [blockNumber, nextListingId] = await Promise.all([
      provider.getBlockNumber(),
      contract.nextListingId(),
    ]);

    return {
      connected: true,
      blockNumber,
      nextListingId: Number(nextListingId),
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message,
    };
  }
};

module.exports = {
  syncBlockchainTrades,
  getChainStatus,
};
