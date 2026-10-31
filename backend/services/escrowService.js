const { ethers } = require('ethers');
const BlockchainService = require('./blockchainService');
const Escrow = require('../models/Escrow');
const auditService = require('./auditService');
const { parsePagination, paginateResults } = require('../utils/paginate');
const { logger, logBackgroundError } = require('../utils/logger');
const { compactUpdate } = require('../utils/compactUpdate');

const STATE_INDEX = ['funded', 'delivered', 'released', 'disputed', 'refunded'];

const normalizeAddr = (addr) => (addr ? String(addr).toLowerCase() : null);

/**
 * Read a single escrow from the chain and return a normalized snapshot.
 */
async function readEscrowFromChain(escrowId) {
  const contract = BlockchainService.getEnergyEscrowContractReadOnly();
  const raw = await contract.getEscrow(escrowId);
  const stateIndex = Number(raw.state ?? raw[3]);
  return {
    escrowId: Number(escrowId),
    buyer: normalizeAddr(raw.buyer ?? raw[0]),
    seller: normalizeAddr(raw.seller ?? raw[1]),
    amount: (raw.amount ?? raw[2]).toString(),
    amountEther: ethers.formatEther(raw.amount ?? raw[2]),
    state: STATE_INDEX[stateIndex] ?? 'unknown',
    stateIndex,
    createdAt: Number(raw.createdAt ?? raw[4]) * 1000,
    deliveredAt: Number(raw.deliveredAt ?? raw[5] ?? 0) * 1000 || null,
  };
}

/**
 * Upsert an escrow mirror record from a parsed on-chain event / read.
 *
 * Only fields the caller actually knows are written. Later events (delivered,
 * released, disputed, refunded) carry just the escrow id and the new state, so
 * they must not overwrite the buyer, seller, amount and listing id stored by the
 * `EscrowCreated` event with nulls.
 */
async function upsertEscrowFromEvent(payload) {
  const { chainId, contractAddress, ...data } = payload;
  if (chainId == null || !contractAddress || data.escrowId == null) return null;

  const update = compactUpdate({
    listingId: data.listingId,
    buyer: normalizeAddr(data.buyer),
    seller: normalizeAddr(data.seller),
    amount: data.amount,
    amountEther: data.amountEther,
    state: data.state,
    createdAt: data.createdAt,
    deliveredAt: data.deliveredAt,
    evidenceCid: data.evidenceCid,
    disputeId: data.disputeId,
    txHash: normalizeAddr(data.txHash),
    blockNumber: data.blockNumber,
    chainId,
    contractAddress: normalizeAddr(contractAddress),
  });

  const result = await Escrow.findOneAndUpdate(
    { chainId, contractAddress: normalizeAddr(contractAddress), escrowId: data.escrowId },
    { $set: update },
    { upsert: true, new: true },
  );
  return result;
}
async function getEscrowById({ escrowId, chainId, contractAddress }) {
  const filter = {};
  if (escrowId != null) filter.escrowId = Number(escrowId);
  if (chainId != null) filter.chainId = Number(chainId);
  if (contractAddress) filter.contractAddress = normalizeAddr(contractAddress);
  return Escrow.findOne(filter).lean();
}

async function listEscrows({ wallet, state, listingId, page, limit }) {
  const query = {};
  if (wallet) {
    const w = normalizeAddr(wallet);
    query.$or = [{ buyer: w }, { seller: w }];
  }
  if (state) query.state = state;
  if (listingId != null) query.listingId = Number(listingId);

  const { page: p, limit: l, skip } = parsePagination({ page, limit }, { maxLimit: 100 });
  const [data, total] = await Promise.all([
    Escrow.find(query).sort({ escrowId: -1 }).skip(skip).limit(l).lean(),
    Escrow.countDocuments(query),
  ]);

  return { data, meta: paginateResults({ page: p, limit: l, total }) };
}

/**
 * Synchronize a single escrow's mirror record against the chain. Used by the
 * dispute service and the verify endpoint to guarantee a fresh view.
 */
async function syncEscrowMirror(escrowId, { chainId, contractAddress } = {}) {
  const onChain = await readEscrowFromChain(escrowId);
  const { energyEscrowAddress } = BlockchainService.getEscrowAddresses();
  return upsertEscrowFromEvent({
    ...onChain,
    chainId,
    contractAddress: contractAddress || energyEscrowAddress,
  });
}

const TX_NOT_FOUND = 'Transaction receipt not found';
const TX_REVERTED = 'Transaction reverted on chain';

/**
 * Index every EnergyEscrow event in a client-signed transaction (same
 * "client signs, backend indexes" flow as the bridge). The data comes from the
 * confirmed receipt on chain, never from the request, so a caller cannot forge
 * an escrow. Each touched escrow is then re-read from the chain so the stored
 * state is exactly what the contract says. Returns the up-to-date records.
 */
async function indexEscrowTx(txHash) {
  const escrowContract = BlockchainService.getEnergyEscrowContractReadOnly();
  const provider = escrowContract.runner?.provider;
  const { energyEscrowAddress } = BlockchainService.getEscrowAddresses();
  if (!provider || !energyEscrowAddress) {
    throw new Error('Escrow provider/address not configured');
  }

  const receipt = await provider.getTransactionReceipt(normalizeAddr(txHash));
  if (!receipt) {
    const err = new Error(TX_NOT_FOUND);
    err.statusCode = 404;
    throw err;
  }
  if (receipt.status !== 1) {
    const err = new Error(TX_REVERTED);
    err.statusCode = 422;
    throw err;
  }

  // Lazy require: blockchainSyncService requires this module at call time.
  const { indexEscrowLog, ESCROW_EVENT_NAMES } = require('./blockchainSyncService');
  const target = normalizeAddr(energyEscrowAddress);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  const touched = new Set();
  for (const log of receipt.logs) {
    if (normalizeAddr(log.address) !== target) continue;
    let parsed;
    try {
      parsed = escrowContract.interface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!parsed || !ESCROW_EVENT_NAMES.includes(parsed.name)) continue;
    await indexEscrowLog(parsed.name, log, parsed, chainId, target, provider);
    touched.add(Number(parsed.args.escrowId ?? parsed.args[0]));
  }

  const records = [];
  for (const escrowId of touched) {
    try {
      await syncEscrowMirror(escrowId, { chainId, contractAddress: target });
    } catch (error) {
      logBackgroundError('escrow.indexTx.mirror', error, { escrowId });
    }
    const record = await getEscrowById({ escrowId, chainId, contractAddress: target });
    if (record) records.push(record);
  }
  return records;
}

const TERMINAL_STATES = new Set(['released', 'refunded']);
const REFRESH_TIMEOUT_MS = 4000;
const REFRESH_MAX_ROWS = 25;

/**
 * Best-effort: re-read escrows that can still change (funded, delivered,
 * disputed) from the chain, so a list never shows a state the contract has
 * already moved past. Bounded in rows and time; any failure keeps the stored row.
 */
async function refreshOpenEscrows(rows) {
  const open = rows.filter((row) => !TERMINAL_STATES.has(row.state)).slice(0, REFRESH_MAX_ROWS);
  if (open.length === 0) return rows;

  const refreshed = new Map();
  const work = Promise.allSettled(
    open.map(async (row) => {
      const doc = await syncEscrowMirror(row.escrowId, {
        chainId: row.chainId,
        contractAddress: row.contractAddress,
      });
      if (doc) refreshed.set(row.escrowId, typeof doc.toObject === 'function' ? doc.toObject() : doc);
    }),
  );
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, REFRESH_TIMEOUT_MS))]);

  return rows.map((row) => refreshed.get(row.escrowId) || row);
}

module.exports = {
  STATE_INDEX,
  readEscrowFromChain,
  upsertEscrowFromEvent,
  getEscrowById,
  listEscrows,
  syncEscrowMirror,
  indexEscrowTx,
  refreshOpenEscrows,
};
