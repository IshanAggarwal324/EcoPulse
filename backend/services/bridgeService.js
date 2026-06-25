const { ethers } = require('ethers');
const BlockchainService = require('./blockchainService');
const BridgeTransfer = require('../models/BridgeTransfer');
const { parsePagination, paginateResults } = require('../utils/paginate');
const { logger, logBackgroundError } = require('../utils/logger');

const normalizeAddr = (addr) => (addr ? String(addr).toLowerCase() : null);

// Must mirror the contract's OP_MINT / OP_RELEASE tags + abi.encodePacked key.
const OP_MINT = 1;
const OP_RELEASE = 2;
const computeNonceHash = (op, sourceChainId, nonce) =>
  ethers.solidityPackedKeccak256(
    ['uint8', 'uint256', 'uint256'],
    [op, sourceChainId, nonce],
  );

const EVENT_TO_DIRECTION = {
  Locked: 'lock',
  Minted: 'mint',
  ReturnedToSource: 'return',
  Released: 'release',
};

/**
 * Idempotent upsert of a bridge event into the mirror collection. Keyed by
 * (chainId, contractAddress, direction, nonce, logIndex) so a re-org re-scan
 * is a no-op.
 */
async function upsertBridgeTransferFromEvent(payload) {
  const {
    chainId,
    contractAddress,
    direction,
    nonce,
    nonceHash = null,
    sourceChainId = null,
    targetChainId = null,
    sender = null,
    recipient = null,
    relayer = null,
    amount,
    amountEther = null,
    status = 'processed',
    txHash,
    logIndex,
    blockNumber = null,
    blockTimestamp = null,
  } = payload;

  if (chainId == null || !contractAddress || !direction || nonce == null || !txHash || logIndex == null) {
    return null;
  }

  const update = {
    direction,
    nonce: String(nonce),
    nonceHash: nonceHash || undefined,
    sourceChainId: sourceChainId != null ? Number(sourceChainId) : null,
    targetChainId: targetChainId != null ? Number(targetChainId) : null,
    sender: normalizeAddr(sender),
    recipient: normalizeAddr(recipient),
    relayer: normalizeAddr(relayer),
    amount: String(amount),
    amountEther,
    status,
    txHash: normalizeAddr(txHash),
    blockNumber: blockNumber != null ? Number(blockNumber) : null,
    blockTimestamp: blockTimestamp != null ? new Date(blockTimestamp) : null,
    processedAt: new Date(),
    contractAddress: normalizeAddr(contractAddress),
  };

  return BridgeTransfer.findOneAndUpdate(
    {
      chainId: Number(chainId),
      contractAddress: normalizeAddr(contractAddress),
      direction,
      nonce: String(nonce),
      logIndex: Number(logIndex),
    },
    { $set: update },
    { upsert: true, new: true },
  );
}

/**
 * Parse a single bridge contract log into a mirror record. Mirrors the escrow
 * `indexEscrowLog` shape so the sync service can dispatch uniformly.
 */
async function indexBridgeLog(eventName, log, parsed, chainId, contractAddress, provider) {
  const direction = EVENT_TO_DIRECTION[eventName];
  if (!direction) return null;

  const args = parsed.args;
  const getArg = (key, index) => (args?.[key] !== undefined ? args[key] : args?.[index]);
  const blockTimestamp = await getBlockTimestamp(provider, log.blockNumber);
  const amount = getArg('amount', 2);
  const txHash = String(log.transactionHash || '').toLowerCase();

  let payload = {
    chainId,
    contractAddress,
    direction,
    txHash,
    logIndex: log.logIndex ?? log.index ?? 0,
    blockNumber: log.blockNumber,
    blockTimestamp,
    amount: amount.toString(),
    amountEther: ethers.formatEther(amount),
  };

  if (eventName === 'Locked') {
    payload.nonce = Number(getArg('lockId', 0));
    payload.sender = String(getArg('sender', 1)).toLowerCase();
    payload.recipient = String(getArg('recipient', 2)).toLowerCase();
    payload.targetChainId = Number(getArg('targetChainId', 4));
  } else if (eventName === 'Minted') {
    const nonce = Number(getArg('nonce', 0));
    const sourceChainId = Number(getArg('sourceChainId', 3));
    payload.nonce = nonce;
    payload.sourceChainId = sourceChainId;
    payload.recipient = String(getArg('recipient', 1)).toLowerCase();
    payload.relayer = String(getArg('relayer', 4)).toLowerCase();
    payload.nonceHash = computeNonceHash(OP_MINT, sourceChainId, nonce);
  } else if (eventName === 'ReturnedToSource') {
    payload.nonce = Number(getArg('returnId', 0));
    payload.sender = String(getArg('sender', 1)).toLowerCase();
    payload.sourceChainId = Number(getArg('sourceChainId', 3));
  } else if (eventName === 'Released') {
    const nonce = Number(getArg('returnId', 0));
    const sourceChainId = Number(getArg('sourceChainId', 3));
    payload.nonce = nonce;
    payload.sourceChainId = sourceChainId;
    payload.recipient = String(getArg('recipient', 1)).toLowerCase();
    payload.relayer = String(getArg('relayer', 4)).toLowerCase();
    payload.nonceHash = computeNonceHash(OP_RELEASE, sourceChainId, nonce);
  }

  return upsertBridgeTransferFromEvent(payload);
}

async function getBlockTimestamp(provider, blockNumber) {
  if (!provider || blockNumber == null) return null;
  try {
    const block = await provider.getBlock(blockNumber);
    return block && block.timestamp ? block.timestamp * 1000 : null;
  } catch (err) {
    logBackgroundError(err, { component: 'bridgeService', stage: 'getBlockTimestamp' });
    return null;
  }
}

/**
 * Parse a transaction receipt and index every CarbonCreditBridge log it
 * contains. Mirrors retirementService.indexRetirementTx for the client-signs,
 * backend-indexes flow. Returns the upserted records.
 */
async function indexBridgeTx(txHash) {
  const provider = BlockchainService.getProvider();
  const { carbonCreditBridgeAddress } = BlockchainService.getBridgeAddresses();
  if (!provider || !carbonCreditBridgeAddress) {
    throw new Error('Bridge provider/address not configured');
  }

  const receipt = await provider.getTransactionReceipt(normalizeAddr(txHash));
  if (!receipt) {
    const err = new Error('Transaction receipt not found');
    err.statusCode = 404;
    throw err;
  }
  if (receipt.status !== 1) {
    const err = new Error('Transaction reverted on chain');
    err.statusCode = 422;
    throw err;
  }

  const bridgeInterface = BlockchainService.getCarbonCreditBridgeContractReadOnly().interface;
  const target = normalizeAddr(carbonCreditBridgeAddress);
  let chainId = Number(receipt.chainId);
  if (!Number.isFinite(chainId)) {
    const network = await provider.getNetwork();
    chainId = Number(network.chainId);
  }

  const records = [];
  for (const log of receipt.logs) {
    if (normalizeAddr(log.address) !== target) continue;
    let parsed;
    try {
      parsed = bridgeInterface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!EVENT_TO_DIRECTION[parsed.name]) continue;
    const record = await indexBridgeLog(
      parsed.name,
      log,
      parsed,
      chainId,
      target,
      provider,
    );
    if (record) records.push(record);
  }
  return records;
}

async function getBridgeTransfer({ id, direction, nonce }) {
  const query = {};
  if (id) query._id = id;
  if (direction) query.direction = direction;
  if (nonce != null) query.nonce = String(nonce);
  return BridgeTransfer.findOne(query).lean();
}

async function listBridgeTransfers({ wallet, direction, sourceChainId, targetChainId, page, limit }) {
  const query = {};
  if (wallet) {
    const w = normalizeAddr(wallet);
    query.$or = [{ sender: w }, { recipient: w }];
  }
  if (direction) query.direction = direction;
  if (sourceChainId != null) query.sourceChainId = Number(sourceChainId);
  if (targetChainId != null) query.targetChainId = Number(targetChainId);

  const { page: p, limit: l, skip } = parsePagination({ page, limit }, { maxLimit: 100 });
  const [data, total] = await Promise.all([
    BridgeTransfer.find(query).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
    BridgeTransfer.countDocuments(query),
  ]);
  return { data, meta: paginateResults({ page: p, limit: l, total }) };
}

let isBridgeListening = false;
let bridgeListenerContracts = [];

const stopListeningToBridgeEvents = () => {
  for (const c of bridgeListenerContracts) {
    try {
      c.removeAllListeners();
    } catch {}
  }
  bridgeListenerContracts = [];
  isBridgeListening = false;
};

/**
 * Real-time listener for bridge events. No-op unless the bridge address is
 * configured. Mirrors `listenToEscrowEvents`.
 */
const listenToBridgeEvents = () => {
  let socketBroadcastService;
  try {
    socketBroadcastService = require('./socketBroadcastService');
  } catch {
    socketBroadcastService = null;
  }

  const { carbonCreditBridgeAddress } = BlockchainService.getBridgeAddresses();
  if (!carbonCreditBridgeAddress) {
    logger.warn('[BridgeSync] CARBON_CREDIT_BRIDGE_ADDRESS not configured; skipping bridge listener.');
    return;
  }

  try {
    const bridgeContract = BlockchainService.getCarbonCreditBridgeContractReadOnly();
    bridgeListenerContracts.push(bridgeContract);
    Object.keys(EVENT_TO_DIRECTION).forEach((name) => {
      if (typeof bridgeContract.filters[name] !== 'function') return;
      bridgeContract.on(name, async (...args) => {
        try {
          const log = args[args.length - 1];
          const parsed = bridgeContract.interface.parseLog(log) || { args: log.args || {} };
          await indexBridgeLog(
            name,
            log,
            parsed,
            Number(process.env.CHAIN_ID || 0),
            carbonCreditBridgeAddress.toLowerCase(),
            BlockchainService.getProvider?.() || null,
          );
          if (socketBroadcastService?.emitBlockchainEventWithAnalytics) {
            socketBroadcastService.emitBlockchainEventWithAnalytics({ eventType: 'bridge_event', name });
          }
        } catch (err) {
          logBackgroundError(err, { component: 'bridgeService', stage: 'realtime', event: name });
        }
      });
    });
    isBridgeListening = true;
    logger.info('[BridgeSync] real-time bridge event listeners started.');
  } catch (err) {
    logBackgroundError(err, { component: 'bridgeService', stage: 'startListener' });
  }
};

module.exports = {
  EVENT_TO_DIRECTION,
  computeNonceHash,
  upsertBridgeTransferFromEvent,
  indexBridgeLog,
  indexBridgeTx,
  getBridgeTransfer,
  listBridgeTransfers,
  listenToBridgeEvents,
  stopListeningToBridgeEvents,
  getBridgeListening: () => isBridgeListening,
};
