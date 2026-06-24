const disputeService = require('../services/disputeService');
const asyncHandler = require('../utils/asyncHandler');

const OUTCOMES = new Set(Object.keys(disputeService.OUTCOME_MAP));

/**
 * GET /api/v1/disputes
 */
const listDisputes = asyncHandler(async (req, res) => {
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'moderator';
  const wallet = isAdmin
    ? req.query.wallet || req.user?.walletAddress || null
    : req.user?.walletAddress || req.query.wallet || null;

  const resolved =
    req.query.resolved === 'true' ? true :
    req.query.resolved === 'false' ? false : null;

  const result = await disputeService.listDisputes({
    wallet,
    resolved,
    escrowId: req.query.escrowId,
    page: req.query.page,
    limit: req.query.limit,
  });

  res.status(200).json({ success: true, data: result.data, meta: result.meta });
});

/**
 * GET /api/v1/disputes/:disputeId
 */
const getDispute = asyncHandler(async (req, res) => {
  const disputeId = parseInt(req.params.disputeId, 10);
  if (Number.isNaN(disputeId) || disputeId < 0) {
    return res.status(400).json({ success: false, message: 'Invalid dispute ID' });
  }

  const dispute = await disputeService.getDisputeById({ disputeId });
  if (!dispute) {
    return res.status(404).json({ success: false, message: 'Dispute not found' });
  }

  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'moderator';
  const wallet = String(req.user?.walletAddress || '').toLowerCase();
  if (!isAdmin && wallet && dispute.buyer !== wallet && dispute.seller !== wallet) {
    return res.status(403).json({ success: false, message: 'Not authorized to view this dispute' });
  }

  res.status(200).json({ success: true, data: dispute });
});

/**
 * POST /api/v1/disputes/:disputeId/evidence
 * Attach off-chain evidence metadata (CID + reason) to an on-chain dispute.
 * Only the buyer or seller of the linked escrow may attach evidence.
 */
const submitEvidence = asyncHandler(async (req, res) => {
  const disputeId = parseInt(req.params.disputeId, 10);
  if (Number.isNaN(disputeId) || disputeId < 0) {
    return res.status(400).json({ success: false, message: 'Invalid dispute ID' });
  }

  const evidenceCid = typeof req.body.evidenceCid === 'string' ? req.body.evidenceCid.trim() : null;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : null;

  if (evidenceCid && evidenceCid.length > 500) {
    return res.status(400).json({ success: false, message: 'evidenceCid is too long' });
  }
  if (reason && reason.length > 1000) {
    return res.status(400).json({ success: false, message: 'reason is too long' });
  }
  if (!evidenceCid && !reason) {
    return res.status(400).json({ success: false, message: 'Provide evidenceCid and/or reason' });
  }

  const dispute = await disputeService.getDisputeById({ disputeId });
  if (!dispute) {
    return res.status(404).json({ success: false, message: 'Dispute not found' });
  }
  if (dispute.resolved) {
    return res.status(409).json({ success: false, message: 'Dispute already resolved' });
  }

  const wallet = String(req.user?.walletAddress || '').toLowerCase();
  if (!wallet) {
    return res.status(403).json({ success: false, message: 'No linked wallet on account' });
  }
  if (dispute.buyer !== wallet && dispute.seller !== wallet) {
    return res.status(403).json({ success: false, message: 'Only a dispute participant may attach evidence' });
  }

  const update = {};
  if (evidenceCid) update.evidenceCid = evidenceCid;
  if (reason) update.reason = reason;

  const Dispute = require('../models/Dispute');
  const updated = await Dispute.findOneAndUpdate(
    { _id: dispute._id },
    { $set: update },
    { new: true },
  ).lean();

  res.status(200).json({ success: true, data: updated });
});

/**
 * POST /api/v1/disputes/:disputeId/resolve  (admin/moderator only)
 */
const resolveDispute = asyncHandler(async (req, res) => {
  const disputeId = parseInt(req.params.disputeId, 10);
  if (Number.isNaN(disputeId) || disputeId < 0) {
    return res.status(400).json({ success: false, message: 'Invalid dispute ID' });
  }

  const outcome = typeof req.body.outcome === 'string' ? req.body.outcome.toLowerCase() : null;
  if (!OUTCOMES.has(outcome)) {
    return res.status(400).json({ success: false, message: 'outcome must be release, refund, or split' });
  }

  const buyerShareBps = outcome === 'split' ? req.body.buyerShareBps : 0;
  const result = await disputeService.resolveDispute(req.user, disputeId, outcome, buyerShareBps, { req });

  res.status(200).json({ success: true, data: result });
});

module.exports = { listDisputes, getDispute, submitEvidence, resolveDispute };
