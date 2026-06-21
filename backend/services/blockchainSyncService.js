const { ethers } = require('ethers');
const Trade = require('../models/Trade');
const SyncState = require('../models/SyncState');
const BlockchainService = require('./blockchainService');
const socketBroadcastService = require('./socketBroadcastService');
const auditService = require('./auditService');
const { logger, logBackgroundError } = require('../utils/logger');
const { invalidateActiveListingsCache } = require('./listingCache');

// TODO(L7): Off-chain signed order book to reduce listing gas costs.
// See P2P_Trading_Production_Readiness.md §3 — Off-Chain Order Books.
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
let eventListenerContract = null;

const stopListeningToBlockchainEvents = () => {
  if (!eventListenerContract) return;

  try {
    eventListenerContract.removeAllListeners();
    logger.info('blockchain event listeners removed', { component: 'blockchain-sync' });
  } catch (err) {
    logger.warn('failed to remove blockchain event listeners', { err, component: 'blockchain-sync' });
  }

  eventListenerContract = null;
};

const getSyncChunkSize = () => {
  const parsed = parseInt(process.env.BLOCKCHAIN_SYNC_CHUNK_SIZE || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SYNC_CHUNK_SIZE;
};

const getLookbackBlocks = () => {
  const parsed = parseInt(process.env.BLOCKCHAIN_SYNC_LOOKBACK || '3000', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3000;
};

// Small re-org safety buffer applied to incremental syncs. Once caught up we
// only re-scan a handful of recent blocks instead of the full lookback window,
// which keeps steady-state syncs cheap and fast.
const getConfirmationsBuffer = () => {
  const parsed = parseInt(process.env.BLOCKCHAIN_SYNC_CONFIRMATIONS || '12', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 12;
};

const getInitialSyncStartBlock = async ({
  provider,
  contractAddress,
  chainId,
  configuredFromBlock,
  toBlock,
}) => {
  if (configuredFromBlock !== null) {
    return configuredFromBlock;
  }

  // Public RPCs often do not reliably support historical code lookups.
  // Start from a bounded recent window to keep sync responsive.
  if (chainId !== 31337) {
    return Math.max(0, toBlock - getLookbackBlocks() + 1);
  }

  return getInitialFromBlock(provider, contractAddress, null);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorCode = (error) =>
  error?.code ?? error?.info?.error?.code ?? error?.error?.code ?? null;

// Provider throttling (e.g. Alchemy "exceeded compute units per second").
// These must be retried with backoff, NOT treated as oversized-range errors.
const isRateLimitError = (error) => {
  const msg = String(error?.message || error).toLowerCase();
  const code = getErrorCode(error);
  return (
    code === 429
    || code === -32005
    || msg.includes('compute units')
    || msg.includes('rate limit')
    || msg.includes('too many requests')
    || msg.includes('429')
    || msg.includes('could not coalesce')
  );
};

// Oversized block-range / too-many-results errors. We deliberately check the
// rate-limit case first so throttling is never misclassified as a range error
// (splitting the range on a 429 amplifies the throttling into a cascade).
const isLogRangeError = (error) => {
  if (isRateLimitError(error)) return false;
  const msg = String(error?.message || error).toLowerCase();
  return (
    msg.includes('block range')
    || msg.includes('log response')
    || msg.includes('more than')
    || msg.includes('too many results')
    || msg.includes('query returned more than')
    || msg.includes('max block')
    || msg.includes('limit exceeded')
  );
};

const MAX_RATE_LIMIT_RETRIES = 6;
const getInterChunkDelayMs = () => {
  const parsed = parseInt(process.env.BLOCKCHAIN_SYNC_CHUNK_DELAY_MS || '250', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
};

const setLastSyncDebug = (payload) => {
  lastSyncDebug = {
    ...payload,
    at: new Date().toISOString(),
  };
};

const fetchLogsForRange = async (contract, filter, start, end, rateLimitAttempt = 0) => {
  try {
    return await contract.queryFilter(filter, start, end);
  } catch (error) {
    // Provider throttling: wait with exponential backoff and retry the SAME
    // range. Never split here — splitting issues more concurrent requests and
    // makes the throttling worse.
    if (isRateLimitError(error)) {
      if (rateLimitAttempt >= MAX_RATE_LIMIT_RETRIES) {
        throw error;
      }
      const backoff = Math.min(8000, 500 * 2 ** rateLimitAttempt);
      await sleep(backoff);
      return fetchLogsForRange(contract, filter, start, end, rateLimitAttempt + 1);
    }

    // Genuinely oversized range: split and fetch the halves sequentially to
    // keep request concurrency low.
    if (isLogRangeError(error) && start < end) {
      const mid = Math.floor((start + end) / 2);
      const left = await fetchLogsForRange(contract, filter, start, mid);
      const right = await fetchLogsForRange(contract, filter, mid + 1, end);
      return [...left, ...right];
    }

    throw error;
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

/**
 * Sub-module 2.4.2 — post-list validation helper.
 *
 * Links a newly-indexed on-chain EnergyListed event to the signed ListingIntent
 * that authorized it (lazy-require to avoid a load-order cycle between the sync
 * service and the pricing/intent services). Audits the outcome so the
 * recommendation → on-chain confirmation loop is observable.
 */
async function linkListedIntent(tradeData, chainId) {
  const { linkOnChainListing } = require('./pricing/listingIntentService');
  const outcome = await linkOnChainListing({
    sellerWallet: tradeData.seller,
    listingId: tradeData.listingId,
    txHash: tradeData.txHash,
    energyAmount: tradeData.energyAmount,
    price: Number(tradeData.price),
    chainId,
  });

  if (outcome.intent) {
    const actorUser = await auditService.resolveActorFromWallet(tradeData.seller);
    auditService
      .log({
        actor: actorUser || { _id: null, email: null, role: null },
        action: 'LISTING_INTENT_LINKED',
        resourceType: 'listing_intent',
        resourceId: String(outcome.intent._id),
        metadata: {
          linked: outcome.linked,
          reason: outcome.reason,
          listingId: tradeData.listingId,
          txHash: tradeData.txHash,
          chainId,
        },
        severity: outcome.linked ? 'info' : 'warn',
      })
      .catch((err) => logBackgroundError('blockchainSync.listingIntentAudit', err, {
        listingId: tradeData.listingId,
      }));
  }

  return outcome;
}

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

        const actorUser = await auditService.resolveActorFromWallet(
          tradeData.seller || tradeData.buyer
        );

        auditService.log({
          actor: actorUser || { _id: null, email: null, role: null },
          action: 'TRADE_SYNCED',
          resourceType: 'trade',
          resourceId: tradeData.txHash,
          metadata: {
            eventType: tradeData.eventType,
            listingId: tradeData.listingId,
            seller: tradeData.seller,
            buyer: tradeData.buyer,
            energyAmount: tradeData.energyAmount,
            price: tradeData.price,
            blockNumber: tradeData.blockNumber,
            chainId,
          },
          severity: 'info',
        });

        // Sub-module 2.4.2 — post-list validation: link a freshly-indexed
        // on-chain listing back to the signed ListingIntent that authorized it.
        // Runs only on NEW inserts so a re-org re-scan never double-links.
        if (tradeData.eventType === 'listed' && tradeData.seller) {
          linkListedIntent(tradeData, chainId).catch((linkErr) => {
            console.warn(
              `[Sync] Post-list intent link failed for listing ${tradeData.listingId}:`,
              linkErr.message,
            );
          });
        }
      }
    } catch (error) {
      console.warn(`[Sync] Skipped ${eventName} log at block ${log.blockNumber}:`, error.message);
    }
  }

  return indexed;
};

const getBlockWithRetry = async (provider, blockNumber, rateLimitAttempt = 0) => {
  try {
    return await provider.getBlock(blockNumber);
  } catch (error) {
    if (isRateLimitError(error) && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
      const backoff = Math.min(8000, 500 * 2 ** rateLimitAttempt);
      await sleep(backoff);
      return getBlockWithRetry(provider, blockNumber, rateLimitAttempt + 1);
    }
    throw error;
  }
};

const getBlockTimestamp = async (provider, blockNumber) => {
  if (blockTimestampCache.has(blockNumber)) {
    return blockTimestampCache.get(blockNumber);
  }

  const block = await getBlockWithRetry(provider, blockNumber);
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
  const getArg = (key, index) => (args?.[key] !== undefined ? args[key] : args?.[index]);
  const base = {
    txHash: String(log.transactionHash || '').toLowerCase(),
    logIndex: Number(log.index ?? log.logIndex ?? 0),
    blockNumber: log.blockNumber,
    blockTimestamp,
    chainId,
    contractAddress,
  };

  if (eventName === 'EnergyListed') {
    return {
      ...base,
      listingId: Number(getArg('listingId', 0)),
      eventType: 'listed',
      seller: String(getArg('seller', 1)).toLowerCase(),
      buyer: null,
      energyAmount: Number(getArg('energyAmount', 2)),
      price: ethers.formatEther(getArg('price', 3)),
    };
  }

  if (eventName === 'EnergyPurchased') {
    return {
      ...base,
      listingId: Number(getArg('listingId', 0)),
      eventType: 'purchased',
      buyer: String(getArg('buyer', 1)).toLowerCase(),
      seller: String(getArg('seller', 2)).toLowerCase(),
      energyAmount: Number(getArg('energyAmount', 3)),
      price: ethers.formatEther(getArg('price', 4)),
    };
  }

  if (eventName === 'ListingCancelled') {
    return {
      ...base,
      listingId: Number(getArg('listingId', 0)),
      eventType: 'cancelled',
      seller: String(getArg('seller', 1)).toLowerCase(),
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
    setLastSyncDebug({
      status: 'skipped',
      message: payload.message,
      indexed: 0,
      lastSyncedBlock: lastSyncDebug.lastSyncedBlock,
    });
    return payload;
  }

  if (!process.env.ENERGY_TRADING_ADDRESS) {
    const payload = {
      skipped: true,
      message: 'ENERGY_TRADING_ADDRESS not configured',
      indexed: 0,
      activeListings: 0,
    };
    setLastSyncDebug({
      status: 'skipped',
      message: payload.message,
      indexed: 0,
      lastSyncedBlock: lastSyncDebug.lastSyncedBlock,
    });
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
    const deploymentBlock = await getInitialSyncStartBlock({
      provider,
      contractAddress,
      chainId,
      configuredFromBlock,
      toBlock,
    });

    let fromBlock;
    if (syncState.lastSyncedBlock > 0) {
      // Incremental: resume just after the last synced block, re-scanning only
      // a small confirmations buffer for re-org safety (not the full lookback).
      fromBlock = Math.max(
        deploymentBlock,
        syncState.lastSyncedBlock - getConfirmationsBuffer() + 1
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

    const interChunkDelayMs = getInterChunkDelayMs();

    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, toBlock);

      // Query each event filter sequentially (not in parallel) to keep the
      // instantaneous request rate low and avoid provider throttling.
      const logGroups = [];
      for (const { name, filter } of filters) {
        const logs = await fetchLogsForRange(contract, filter, start, end);
        logGroups.push({ name, logs });
      }

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

      // Persist progress after every chunk so an interruption (or later
      // throttling) never forces a full re-scan from the start.
      syncState.lastSyncedBlock = end;
      syncState.chainId = chainId;
      syncState.contractAddress = contractAddress;
      await syncState.save();

      console.log(`[Sync] Indexed blocks ${start}-${end}, total new trades this run: ${indexed}`);

      // Brief pause between chunks to stay under the provider's CU/s budget.
      if (interChunkDelayMs > 0 && end < toBlock) {
        await sleep(interChunkDelayMs);
      }
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
    await invalidateActiveListingsCache().catch((err) => {
      logBackgroundError('blockchainSync.invalidateListingCache', err);
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

const CHAIN_NAMES = {
  11155111: 'Sepolia',
  31337: 'Hardhat',
};

const getSyncLagThreshold = () => {
  const parsed = parseInt(process.env.HEALTH_SYNC_LAG_THRESHOLD || '50', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
};

const getChainStatus = async () => {
  try {
    const contract = BlockchainService.getEnergyTradingContractReadOnly();
    const provider = contract.runner.provider;
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    const [blockNumber, nextListingId, syncState] = await Promise.all([
      provider.getBlockNumber(),
      contract.nextListingId(),
      SyncState.findOne({ key: SYNC_STATE_KEY }).lean(),
    ]);

    const lastSyncedBlock = syncState?.lastSyncedBlock ?? 0;
    const syncLagBlocks = Math.max(0, blockNumber - lastSyncedBlock);
    const lagThreshold = getSyncLagThreshold();

    return {
      connected: true,
      chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
      blockNumber,
      chainId,
      nextListingId: Number(nextListingId),
      lastSyncedBlock,
      syncLagBlocks,
      isSyncHealthy: syncLagBlocks <= lagThreshold,
      tradeCount: await Trade.estimatedDocumentCount(),
      lastSync: lastSyncDebug,
    };
  } catch (error) {
    return {
      connected: false,
      chainName: null,
      syncLagBlocks: null,
      isSyncHealthy: false,
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
    const contractAddress = process.env.ENERGY_TRADING_ADDRESS.toLowerCase();
    eventListenerContract = contract;

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
  stopListeningToBlockchainEvents,
};

