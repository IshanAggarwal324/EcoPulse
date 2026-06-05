const { ethers } = require('ethers');
const Trade = require('../models/Trade');
const SyncState = require('../models/SyncState');
const BlockchainService = require('./blockchainService');
const socketBroadcastService = require('./socketBroadcastService');

const SYNC_STATE_KEY = 'energy_trading';
const DEFAULT_SYNC_CHUNK_SIZE = 500;
let isSyncing = false;
let lastSyncDebug = {
  status: 'idle',
  message: null,
  indexed: 0,
  lastSyncedBlock: 0,
  at: null,
};

const blockTimestampCache = new Map();

const getSyncChunkSize = () => {
  const parsed = parseInt(process.env.BLOCKCHAIN_SYNC_CHUNK_SIZE || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SYNC_CHUNK_SIZE;
};

const getLookbackBlocks = () => {
  const parsed = parseInt(process.env.BLOCKCHAIN_SYNC_LOOKBACK || '3000', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3000;
};

const isLogRangeError = (error) => {
  const msg = String(error?.message || error).toLowerCase();
  return (
    msg.includes('block range')
    || msg.includes('log response')
    || msg.includes('exceed')
    || msg.includes('too many')
    || msg.includes('query returned more than')
    || msg.includes('max block')
  );
};

const setLastSyncDebug = (payload) => {
  lastSyncDebug = {
    ...payload,
    at: new Date().toISOString(),
  };
};

const fetchLogsForRange = async (contract, filter, start, end) => {
  try {
    return await contract.queryFilter(filter, start, end);
  } catch (error) {
    if (!isLogRangeError(error) || start >= end) {
      throw error;
    }

    const mid = Math.floor((start + end) / 2);
    const [left, right] = await Promise.all([
      fetchLogsForRange(contract, filter, start, mid),
      fetchLogsForRange(contract, filter, mid + 1, end),
    ]);

    return [...left, ...right];
  }
};

const getInitialFromBlock = async (provider, contractAddress, configuredFromBlock) => {
  if (configuredFromBlock !== null) {
    return configuredFromBlock;
  }

  let low = 0;
  let high = await provider.getBlockNumber();

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await provider.getCode(contractAddress, mid);
    if (code && code !== '0x') {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low;
};

const indexLogs = async (contract, logs, eventName, provider, chainId, contractAddress) => {
  let indexed = 0;

  for (const log of logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      const tradeData = await parseEventTrade(
        eventName,
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

      if (result.upsertedCount > 0 || result.upsertedId) {
        indexed += 1;
      }
    } catch (error) {
      console.warn(`[Sync] Skipped ${eventName} log at block ${log.blockNumber}:`, error.message);
    }
  }

  return indexed;
};

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
    const payload = { skipped: true, message: 'Sync already in progress' };
    setLastSyncDebug({ status: 'skipped', message: payload.message, indexed: 0, lastSyncedBlock: 0 });
    return payload;
  }

  if (!process.env.ENERGY_TRADING_ADDRESS) {
    const payload = {
      skipped: true,
      message: 'ENERGY_TRADING_ADDRESS not configured',
      indexed: 0,
      activeListings: 0,
    };
    setLastSyncDebug({ status: 'skipped', message: payload.message, indexed: 0, lastSyncedBlock: 0 });
    return payload;
  }

  isSyncing = true;
  let indexed = 0;

  try {
    const contract = BlockchainService.getEnergyTradingContractReadOnly();
    const provider = contract.runner.provider;
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    const contractAddress = process.env.ENERGY_TRADING_ADDRESS.toLowerCase();

    const syncState = await getSyncCursor(chainId, contractAddress);
    const toBlock = await provider.getBlockNumber();
    const chunkSize = getSyncChunkSize();
    const configuredFromBlock = process.env.BLOCKCHAIN_SYNC_FROM_BLOCK
      ? parseInt(process.env.BLOCKCHAIN_SYNC_FROM_BLOCK, 10)
      : null;
    const deploymentBlock = configuredFromBlock
      ?? await getInitialFromBlock(provider, contractAddress, null);

    let fromBlock;
    if (syncState.lastSyncedBlock > 0) {
      fromBlock = Math.max(
        deploymentBlock,
        syncState.lastSyncedBlock - getLookbackBlocks() + 1
      );
    } else {
      fromBlock = deploymentBlock;
      console.log(`[Sync] Starting from block ${fromBlock} (chunk size: ${chunkSize})`);
    }

    // Detect local blockchain reset (e.g. npx hardhat node restarted)
    if (toBlock < syncState.lastSyncedBlock && chainId === 31337) {
      console.log('[Sync] Detected local blockchain reset. Clearing old trade history...');
      await Trade.deleteMany({});
      syncState.lastSyncedBlock = 0;
      await syncState.save();
      fromBlock = 0;
    }

    if (fromBlock > toBlock) {
      const result = {
        indexed: 0,
        activeListings: null,
        fromBlock,
        toBlock,
        lastSyncedBlock: syncState.lastSyncedBlock,
        syncedAt: new Date().toISOString(),
      };
      setLastSyncDebug({
        status: 'ok',
        message: 'Already up to date',
        indexed: 0,
        lastSyncedBlock: syncState.lastSyncedBlock,
      });
      return result;
    }

    const filters = [
      { name: 'EnergyListed', filter: contract.filters.EnergyListed() },
      { name: 'EnergyPurchased', filter: contract.filters.EnergyPurchased() },
      { name: 'ListingCancelled', filter: contract.filters.ListingCancelled() },
    ];

    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, toBlock);

      const logGroups = await Promise.all(
        filters.map(({ name, filter }) =>
          fetchLogsForRange(contract, filter, start, end).then((logs) => ({ name, logs }))
        )
      );

      for (const { name, logs } of logGroups) {
        indexed += await indexLogs(
          contract,
          logs,
          name,
          provider,
          chainId,
          contractAddress
        );
      }

      syncState.lastSyncedBlock = end;
      syncState.chainId = chainId;
      syncState.contractAddress = contractAddress;
      await syncState.save();

      console.log(`[Sync] Indexed blocks ${start}-${end}, total new trades this run: ${indexed}`);
    }

    const result = {
      indexed,
      activeListings: null,
      fromBlock,
      toBlock,
      lastSyncedBlock: toBlock,
      syncedAt: new Date().toISOString(),
    };
    setLastSyncDebug({
      status: 'ok',
      message: null,
      indexed,
      lastSyncedBlock: toBlock,
    });
    return result;
  } catch (error) {
    console.error('[Sync] Blockchain trade sync failed:', error.message);
    const result = {
      skipped: true,
      message: error.message,
      indexed,
      activeListings: 0,
      syncedAt: new Date().toISOString(),
    };
    setLastSyncDebug({
      status: 'error',
      message: error.message,
      indexed,
      lastSyncedBlock: lastSyncDebug.lastSyncedBlock,
    });
    return result;
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
    const contract = BlockchainService.getEnergyTradingContractReadOnly();
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
      lastSync: lastSyncDebug,
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message,
      lastSync: lastSyncDebug,
    };
  }
};

const listenToBlockchainEvents = () => {
  if (!process.env.ENERGY_TRADING_ADDRESS) {
    console.warn('[Sync] ENERGY_TRADING_ADDRESS not configured for real-time listening.');
    return;
  }

  try {
    const contract = BlockchainService.getEnergyTradingContractReadOnly();
    const provider = contract.runner.provider;
    const contractAddress = process.env.ENERGY_TRADING_ADDRESS.toLowerCase();

    console.log(`[Sync] Starting real-time blockchain event listeners on contract ${contractAddress}...`);

    contract.on('EnergyListed', async (listingId, seller, energyAmount, price) => {
      const listingIdNum = Number(listingId);
      console.log(`[Sync] Real-time event detected: EnergyListed (listingId: ${listingIdNum}, seller: ${seller}, amount: ${energyAmount}, price: ${price})`);
      try {
        const syncResult = await syncBlockchainTrades();
        console.log('[Sync] Event synced to MongoDB:', syncResult);

        socketBroadcastService.emitBlockchainEventWithAnalytics({
          eventType: 'listed',
          listingId: listingIdNum,
          seller,
          energyAmount: energyAmount.toString(),
          price: ethers.formatEther(price),
        });
      } catch (err) {
        console.error('[Sync] Error processing real-time EnergyListed event:', err.message);
      }
    });

    contract.on('EnergyPurchased', async (listingId, buyer, seller, energyAmount, price) => {
      const listingIdNum = Number(listingId);
      console.log(`[Sync] Real-time event detected: EnergyPurchased (listingId: ${listingIdNum}, buyer: ${buyer}, seller: ${seller}, amount: ${energyAmount}, price: ${price})`);
      try {
        const syncResult = await syncBlockchainTrades();
        console.log('[Sync] Event synced to MongoDB:', syncResult);

        socketBroadcastService.emitBlockchainEventWithAnalytics({
          eventType: 'purchased',
          listingId: listingIdNum,
          buyer,
          seller,
          energyAmount: energyAmount.toString(),
          price: ethers.formatEther(price),
        });
      } catch (err) {
        console.error('[Sync] Error processing real-time EnergyPurchased event:', err.message);
      }
    });

    contract.on('ListingCancelled', async (listingId, seller) => {
      const listingIdNum = Number(listingId);
      console.log(`[Sync] Real-time event detected: ListingCancelled (listingId: ${listingIdNum}, seller: ${seller})`);
      try {
        const syncResult = await syncBlockchainTrades();
        console.log('[Sync] Event synced to MongoDB:', syncResult);

        socketBroadcastService.emitBlockchainEventWithAnalytics({
          eventType: 'cancelled',
          listingId: listingIdNum,
          seller,
        });
      } catch (err) {
        console.error('[Sync] Error processing real-time ListingCancelled event:', err.message);
      }
    });

  } catch (err) {
    console.error('[Sync] Failed to initialize real-time blockchain event listeners:', err.message);
  }
};

module.exports = {
  syncBlockchainTrades,
  getChainStatus,
  getLastSyncDebug: () => lastSyncDebug,
  listenToBlockchainEvents,
};

