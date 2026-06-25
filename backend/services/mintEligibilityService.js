const { ethers } = require('ethers');
const BlockchainService = require('./blockchainService');
const CreditAward = require('../models/CreditAward');
const auditService = require('./auditService');
const { logger, logBackgroundError } = require('../utils/logger');

/**
 * Module 5.3.7 — mint-to-earn eligibility + award.
 *
 * Turning verified green generation into mintable CC is gated by deterministic
 * rules so credits cannot be minted arbitrarily:
 *   - positive kWh within a per-tx cap,
 *   - a configurable CC-per-kWh rate,
 *   - a per-node rolling 24h cap,
 *   - a one-shot evidence hash so the same reading window is never paid twice.
 *
 * The actual generation verification (signed meter readings / forecasts) is
 * supplied by the caller — a trusted system job or admin — and is captured in
 * the evidence hash. Endpoint access is admin-only.
 */
const CC_PER_KWH = Number(process.env.CC_PER_KWH || '1');
const MAX_KWH_PER_TX = Number(process.env.MINT_MAX_KWH_PER_TX || '100000');
const MAX_KWH_PER_NODE_PER_DAY = Number(process.env.MINT_MAX_KWH_PER_NODE_PER_DAY || '1000000');

const normalizeAddr = (addr) => (addr ? String(addr).toLowerCase() : null);

const computeEvidenceHash = ({ nodeId, windowStart, windowEnd, kwh }) =>
  ethers.keccak256(
    ethers.solidityPacked(
      ['string', 'uint256', 'uint256', 'uint256'],
      [
        String(nodeId || ''),
        Math.floor(new Date(windowStart || 0).getTime() / 1000),
        Math.floor(new Date(windowEnd || Date.now()).getTime() / 1000),
        Math.round(Number(kwh || 0)),
      ],
    ),
  );

/**
 * Pure eligibility decision (no DB / no chain). Unit-testable.
 */
function evaluateEligibility({ recipient, nodeId, kwh, windowStart, windowEnd }) {
  const kwhNum = Number(kwh);
  if (!recipient || !ethers.isAddress(recipient)) {
    return { eligible: false, reason: 'Invalid recipient address' };
  }
  if (!Number.isFinite(kwhNum) || kwhNum <= 0) {
    return { eligible: false, reason: 'kWh must be a positive number' };
  }
  if (kwhNum > MAX_KWH_PER_TX) {
    return { eligible: false, reason: `kWh exceeds per-tx cap (${MAX_KWH_PER_TX})` };
  }

  const ccAmount = kwhNum * CC_PER_KWH;
  const evidenceHash = computeEvidenceHash({ nodeId, windowStart, windowEnd, kwh: kwhNum });

  return {
    eligible: true,
    ccAmount: ccAmount.toFixed(6),
    kwh: kwhNum,
    rate: CC_PER_KWH,
    evidenceHash,
  };
}

/**
 * Award credits for verified generation. Idempotent on evidenceHash.
 */
async function awardCredits({ recipient, nodeId, kwh, windowStart, windowEnd, evidence = {}, actor } = {}) {
  const decision = evaluateEligibility({ recipient, nodeId, kwh, windowStart, windowEnd });
  if (!decision.eligible) {
    const err = new Error(decision.reason);
    err.statusCode = 400;
    throw err;
  }

  // Per-node 24h cap check (best-effort; ignored on aggregation failure).
  try {
    if (nodeId && windowEnd) {
      const since = new Date(new Date(windowEnd).getTime() - 24 * 60 * 60 * 1000);
      const recent = await CreditAward.aggregate([
        { $match: { nodeId, status: 'awarded', createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$kwh' } } },
      ]);
      const used = recent[0]?.total || 0;
      if (used + decision.kwh > MAX_KWH_PER_NODE_PER_DAY) {
        const err = new Error(`Per-node daily kWh cap exceeded (${MAX_KWH_PER_NODE_PER_DAY})`);
        err.statusCode = 422;
        throw err;
      }
    }
  } catch (e) {
    if (e.statusCode) throw e;
    logBackgroundError(e, { component: 'mintEligibilityService', stage: 'dailyCap' });
  }

  const carbonAddress = process.env.CARBON_CREDIT_ADDRESS;
  let chainId = Number(process.env.CHAIN_ID || 0);
  if (!Number.isFinite(chainId) || chainId === 0) {
    try {
      const network = await BlockchainService.getProvider().getNetwork();
      chainId = Number(network.chainId);
    } catch {}
  }

  // Idempotency: a duplicate evidence hash is a no-op success returning the
  // existing award (replay-safe under retries).
  const existing = await CreditAward.findOne({
    chainId,
    contractAddress: normalizeAddr(carbonAddress),
    evidenceHash: decision.evidenceHash,
  });
  if (existing) {
    return { record: existing, replay: true };
  }

  const record = await CreditAward.create({
    chainId,
    contractAddress: normalizeAddr(carbonAddress),
    recipient: normalizeAddr(recipient),
    nodeId: nodeId || null,
    kwh: decision.kwh,
    windowStart: windowStart ? new Date(windowStart) : null,
    windowEnd: windowEnd ? new Date(windowEnd) : null,
    ccAmount: decision.ccAmount,
    ccAmountEther: decision.ccAmount,
    evidenceHash: decision.evidenceHash,
    status: 'pending',
    awardedBy: actor?.email || actor?.id?.toString() || null,
    metadata: evidence,
  });

  try {
    const txHash = await BlockchainService.mintTokens(normalizeAddr(recipient), decision.ccAmount);
    record.txHash = normalizeAddr(txHash);
    record.status = 'awarded';
    record.awardedAt = new Date();
    await record.save();
  } catch (e) {
    record.status = 'failed';
    record.failureReason = e.message?.slice(0, 500) || 'mint failed';
    await record.save();
    logBackgroundError(e, { component: 'mintEligibilityService', stage: 'mint' });
    throw e;
  }

  try {
    await auditService.log({
      action: 'carbon.award',
      resourceType: 'trade',
      resourceId: record._id.toString(),
      actorId: actor?.id || null,
      actorEmail: actor?.email || null,
      actorRole: actor?.role || null,
      severity: 'info',
      metadata: { recipient: normalizeAddr(recipient), nodeId, kwh: decision.kwh, ccAmount: decision.ccAmount },
    });
  } catch (e) {
    logBackgroundError(e, { component: 'mintEligibilityService', stage: 'audit' });
  }

  return { record, replay: false };
}

module.exports = {
  CC_PER_KWH,
  MAX_KWH_PER_TX,
  MAX_KWH_PER_NODE_PER_DAY,
  computeEvidenceHash,
  evaluateEligibility,
  awardCredits,
};
