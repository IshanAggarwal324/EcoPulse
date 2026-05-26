const { ethers } = require('ethers');
const Trade = require('../models/Trade');
const SyncState = require('../models/SyncState');
const BlockchainService = require('./blockchainService');

const SYNC_STATE_KEY = 'energy_trading';
let isSyncing = false;

const blockTimestampCache = new Map();

const getBlockTimestamp = async (provider, blockNumber) => {
  if (blockTimestampCache.has(blockNumber)) {
    return blockTimestampCache.get(blockNumber);
  }

  const block = await provider.getBlock(blockNumber);
  const timestamp = block ? new Date(block.timestamp * 1000) : new Date();
  blockTimestampCache.set(blockNumber, timestamp);

  if (blockTimestampCache.size > 500) {
    const oldestKey = blockTimestampCache.keys().next().value;
    blockTimestampCache.delete(oldestKey);
  }

  return timestamp;
};

const parseEventTrade = async (eventName, log, args, provider, chainId, contractAddress) => {
  const blockTimestamp = await getBlockTimestamp(provider, log.blockNumber);
  const base = {
    txHash: log.transactionHash,
    logIndex: log.index,
    blockNumber: log.blockNumber,
    blockTimestamp,
    chainId,
    contractAddress,
  };

  if (eventName === 'EnergyListed') {
    return {
      ...base,
      listingId: Number(args.listingId),
      eventType: 'listed',
      seller: String(args.seller).toLowerCase(),
      buyer: null,
      energyAmount: Number(args.energyAmount),
      price: ethers.formatEther(args.price),
    };
  }

  if (eventName === 'EnergyPurchased') {
    return {
      ...base,
      listingId: Number(args.listingId),
      eventType: 'purchased',
      seller: String(args.seller).toLowerCase(),
      buyer: String(args.buyer).toLowerCase(),
      energyAmount: Number(args.energyAmount),
      price: ethers.formatEther(args.price),
    };
  }

  if (eventName === 'ListingCancelled') {
    return {
      ...base,
      listingId: Number(args.listingId),
      eventType: 'cancelled',
      seller: String(args.seller).toLowerCase(),
      buyer: null,
      energyAmount: 0,
      price: '0',
    };
  }

  return null;
};

const getSyncCursor = async (chainId, contractAddress) => {
  const state = await SyncState.findOneAndUpdate(
    { key: SYNC_STATE_KEY },
    {
      $setOnInsert: {
        key: SYNC_STATE_KEY,
        lastSyncedBlock: 0,
        chainId,
        contractAddress,
      },
    },
    { upsert: true, new: true }
  );

  if (state.chainId !== chainId || state.contractAddress !== contractAddress) {
    state.chainId = chainId;
    state.contractAddress = contractAddress;
    state.lastSyncedBlock = 0;
    await state.save();
  }

  return state;
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
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    const contractAddress = process.env.ENERGY_TRADING_ADDRESS.toLowerCase();

    const syncState = await getSyncCursor(chainId, contractAddress);
    const fromBlock = syncState.lastSyncedBlock > 0 ? syncState.lastSyncedBlock + 1 : 0;
    const toBlock = await provider.getBlockNumber();

    if (fromBlock > toBlock) {
      return {
        indexed: 0,
        activeListings: await countActiveListings(contract),
        fromBlock,
        toBlock,
        lastSyncedBlock: syncState.lastSyncedBlock,
        syncedAt: new Date().toISOString(),
      };
    }

    const filters = [
      { name: 'EnergyListed', filter: contract.filters.EnergyListed() },
      { name: 'EnergyPurchased', filter: contract.filters.EnergyPurchased() },
      { name: 'ListingCancelled', filter: contract.filters.ListingCancelled() },
    ];

    for (const { name, filter } of filters) {
      const logs = await contract.queryFilter(filter, fromBlock, toBlock);

      for (const log of logs) {
        const parsed = contract.interface.parseLog(log);
        const tradeData = await parseEventTrade(
          name,
          log,
          parsed.args,
          provider,
          chainId,
          contractAddress
        );

        if (!tradeData) continue;

        const result = await Trade.updateOne(
          { txHash: tradeData.txHash, logIndex: tradeData.logIndex },
          { $setOnInsert: tradeData },
          { upsert: true }
        );

        if (result.upsertedCount > 0) {
          indexed += 1;
        }
      }
    }

    syncState.lastSyncedBlock = toBlock;
    syncState.chainId = chainId;
    syncState.contractAddress = contractAddress;
    await syncState.save();

    return {
      indexed,
      activeListings: await countActiveListings(contract),
      fromBlock,
      toBlock,
      lastSyncedBlock: toBlock,
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

const countActiveListings = async (contract) => {
  try {
    const nextId = Number(await contract.nextListingId());
    let activeListings = 0;

    for (let i = 0; i < nextId; i += 1) {
      const isActive = await contract.isListingActive(i);
      if (isActive) activeListings += 1;
    }

    return activeListings;
  } catch {
    return 0;
  }
};

const getChainStatus = async () => {
  try {
    const contract = BlockchainService.getEnergyTradingContract();
    const provider = contract.runner.provider;
    const network = await provider.getNetwork();
    const [blockNumber, nextListingId, syncState] = await Promise.all([
      provider.getBlockNumber(),
      contract.nextListingId(),
      SyncState.findOne({ key: SYNC_STATE_KEY }).lean(),
    ]);

    return {
      connected: true,
      blockNumber,
      chainId: Number(network.chainId),
      nextListingId: Number(nextListingId),
      lastSyncedBlock: syncState?.lastSyncedBlock ?? 0,
      tradeCount: await Trade.countDocuments(),
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
