const { ethers } = require('ethers');
const BlockchainService = require('./blockchainService');
const Dispute = require('../models/Dispute');
const Escrow = require('../models/Escrow');
const auditService = require('./auditService');
const socketBroadcastService = require('./socketBroadcastService');
const { parsePagination, paginateResults } = require('../utils/paginate');
const { WALLET_REGEX } = require('../utils/validators');
const { logBackgroundError } = require('../utils/logger');

const OUTCOME_MAP = { release: 0, refund: 1, split: 2 };
const OUTCOME_INDEX = ['release', 'refund', 'split'];

const normalizeAddr = (addr) => (addr ? String(addr).toLowerCase() : null);

/**
 * Read a dispute record from the chain.
 */
async function readDisputeFromChain(disputeId) {
  const contract = BlockchainService.getDisputeResolutionContractReadOnly();
  const raw = await contract.disputes(disputeId);
  return {
    disputeId: Number(disputeId),
    escrowId: Number(raw.escrowId ?? raw[0]),
    buyer: normalizeAddr(raw.buyer ?? raw[1]),
    seller: normalizeAddr(raw.seller ?? raw[2]),
    amount: (raw.amount ?? raw[3]).toString(),
    evidenceHash: (raw.evidenceHash ?? raw[4]) && (raw.evidenceHash ?? raw[4]) !== ethers.ZeroHash
      ? (raw.evidenceHash ?? raw[4])
      : null,
    resolved: Boolean(raw.resolved ?? raw[5]),
    outcome: OUTCOME_INDEX[Number(raw.outcome ?? raw[6])] ?? null,
    openedAt: Number(raw.createdAt ?? raw[7]) * 1000,
  };
}

async function upsertDisputeFromEvent(payload) {
  const { chainId, contractAddress, ...data } = payload;
  if (chainId == null || !contractAddress || data.disputeId == null) return null;

  const update = {
    escrowId: data.escrowId,
    buyer: normalizeAddr(data.buyer),
    seller: normalizeAddr(data.seller),
    amount: data.amount,
    evidenceHash: data.evidenceHash ?? null,
    evidenceCid: data.evidenceCid ?? null,
    reason: data.reason ?? null,
    resolved: data.resolved ?? false,
    outcome: data.outcome ?? null,
    buyerShareBps: data.buyerShareBps ?? null,
    resolvedBy: normalizeAddr(data.resolvedBy),
    resolvedAt: data.resolvedAt ?? null,
    openedAt: data.openedAt ?? null,
    txHash: normalizeAddr(data.txHash),
    blockNumber: data.blockNumber ?? null,
    chainId,
    contractAddress: normalizeAddr(contractAddress),
  };

  const result = await Dispute.findOneAndUpdate(
    { chainId, contractAddress: normalizeAddr(contractAddress), disputeId: data.disputeId },
    { $set: update },
    { upsert: true, new: true },
  );
  return result;
}

async function getDisputeById({ disputeId, chainId, contractAddress }) {
  const filter = {};
  if (disputeId != null) filter.disputeId = Number(disputeId);
  if (chainId != null) filter.chainId = Number(chainId);
  if (contractAddress) filter.contractAddress = normalizeAddr(contractAddress);
  return Dispute.findOne(filter).lean();
}

async function listDisputes({ wallet, resolved, escrowId, page, limit }) {
  const query = {};
  if (wallet) {
    const w = normalizeAddr(wallet);
    query.$or = [{ buyer: w }, { seller: w }];
  }
  if (resolved != null) query.resolved = resolved === true || resolved === 'true';
  if (escrowId != null) query.escrowId = Number(escrowId);

  const { page: p, limit: l, skip } = parsePagination({ page, limit }, { maxLimit: 100 });
  const [data, total] = await Promise.all([
    Dispute.find(query).sort({ disputeId: -1 }).skip(skip).limit(l).lean(),
    Dispute.countDocuments(query),
  ]);

  return { data, meta: paginateResults({ page: p, limit: l, total }) };
}

/**
 * Resolve a dispute on-chain via the relayer wallet. The relayer must hold
 * ARBITER_ROLE on the DisputeResolution contract; otherwise the transaction
 * reverts on-chain. In production, keep ARBITER_ROLE on a multisig and resolve
 * directly — this helper is for operational/admin resolution only.
 *
 * @param {object} actor Admin user performing the action (for audit).
 * @param {number} disputeId On-chain dispute id.
 * @param {string} outcome 'release' | 'refund' | 'split'
 * @param {number} buyerShareBps Required for 'split' (0–10000).
 */
async function resolveDispute(actor, disputeId, outcome, buyerShareBps, { req } = {}) {
  const outcomeCode = OUTCOME_MAP[outcome];
  if (outcomeCode === undefined) {
    const err = new Error('Invalid outcome. Must be release, refund, or split.');
    err.statusCode = 400;
    throw err;
  }
  if (outcome === 'split') {
    const share = Number(buyerShareBps);
    if (!Number.isFinite(share) || share < 0 || share > 10000) {
      const err = new Error('buyerShareBps must be an integer between 0 and 10000 for a split.');
      err.statusCode = 400;
      throw err;
    }
    buyerShareBps = share;
  } else {
    buyerShareBps = 0;
  }

  const contract = BlockchainService.getDisputeResolutionContract();
  const tx = await contract.resolve(disputeId, outcomeCode, buyerShareBps);
  const receipt = await tx.wait();

  // Best-effort: record the on-chain resolution locally.
  try {
    const onChain = await readDisputeFromChain(disputeId);
    const { disputeResolutionAddress } = BlockchainService.getEscrowAddresses();
    const provider = contract.runner?.provider;
    let chainId = null;
    let blockNumber = null;
    if (provider) {
      const network = await provider.getNetwork();
      chainId = Number(network.chainId);
      blockNumber = receipt.blockNumber;
    }
    await upsertDisputeFromEvent({
      ...onChain,
      resolved: true,
      outcome,
      buyerShareBps,
      resolvedBy: normalizeAddr(await contract.runner.getAddress?.()),
      resolvedAt: new Date().toISOString(),
      txHash: receipt.hash,
      blockNumber,
      chainId,
      contractAddress: disputeResolutionAddress,
    });

    // Keep the linked escrow mirror fresh.
    if (chainId != null) {
      const escrowService = require('./escrowService');
      await escrowService.syncEscrowMirror(onChain.escrowId, { chainId, contractAddress: process.env.ENERGY_ESCROW_ADDRESS });
    }
  } catch (mirrorErr) {
    logBackgroundError('disputeService.resolveDispute.mirror', mirrorErr, { disputeId });
  }

  auditService.log({
    actor,
    action: 'DISPUTE_RESOLVED',
    resourceType: 'dispute',
    resourceId: String(disputeId),
    metadata: { outcome, buyerShareBps, txHash: receipt.hash },
    req,
    severity: 'warn',
  }).catch((e) => logBackgroundError('disputeService.resolveDispute.audit', e));

  socketBroadcastService.emitBlockchainEventWithAnalytics({
    eventType: 'dispute_resolved',
    disputeId,
    outcome,
  }).catch(() => {});

  return { disputeId, outcome, buyerShareBps, txHash: receipt.hash };
}

module.exports = {
  OUTCOME_MAP,
  OUTCOME_INDEX,
  readDisputeFromChain,
  upsertDisputeFromEvent,
  getDisputeById,
  listDisputes,
  resolveDispute,
};
