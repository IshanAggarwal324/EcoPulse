const { ethers } = require('ethers');
const BlockchainService = require('./blockchainService');
const Escrow = require('../models/Escrow');
const auditService = require('./auditService');
const { parsePagination, paginateResults } = require('../utils/paginate');
const { logger, logBackgroundError } = require('../utils/logger');

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
 */
async function upsertEscrowFromEvent(payload) {
  const { chainId, contractAddress, ...data } = payload;
  if (chainId == null || !contractAddress || data.escrowId == null) return null;

  const update = {
    listingId: data.listingId ?? null,
    buyer: normalizeAddr(data.buyer),
    seller: normalizeAddr(data.seller),
    amount: data.amount,
    amountEther: data.amountEther ?? null,
    state: data.state,
    createdAt: data.createdAt ?? null,
    deliveredAt: data.deliveredAt ?? null,
    evidenceCid: data.evidenceCid ?? null,
    disputeId: data.disputeId ?? null,
    txHash: normalizeAddr(data.txHash),
    blockNumber: data.blockNumber ?? null,
    chainId,
    contractAddress: normalizeAddr(contractAddress),
  };

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

module.exports = {
  STATE_INDEX,
  readEscrowFromChain,
  upsertEscrowFromEvent,
  getEscrowById,
  listEscrows,
  syncEscrowMirror,
};
