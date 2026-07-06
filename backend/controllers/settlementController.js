const mongoose = require('mongoose');
const Settlement = require('../models/Settlement');
const settlementVerificationService = require('../services/settlementVerificationService');
const reconciliationService = require('../services/reconciliationService');
const { parsePagination, paginateResults } = require('../utils/paginate');
const asyncHandler = require('../utils/asyncHandler');

const VERIFICATION_STATUSES = new Set(Settlement.VERIFICATION_STATUSES);
const MISMATCH_FLAGS = new Set(Settlement.MISMATCH_FLAGS);

const isAdmin = (req) => req.user?.role === 'admin' || req.user?.role === 'moderator';

/**
 * GET /api/v1/settlements
 * Non-admins are scoped to settlements where they are buyer or seller.
 */
const listSettlements = asyncHandler(async (req, res) => {
  const admin = isAdmin(req);
  const wallet = String(req.user?.walletAddress || '').toLowerCase();

  const query = {};

  // Ownership scoping. Admins may pass ?wallet to inspect anyone; non-admins
  // are hard-scoped to their own wallet regardless of the query param.
  const scopeWallet = admin
    ? (req.query.wallet ? String(req.query.wallet).toLowerCase() : null)
    : wallet;
  if (!admin && scopeWallet) {
    query.$or = [{ buyer: scopeWallet }, { seller: scopeWallet }];
  } else if (!admin) {
    // No wallet on file → nothing to show.
    return res.status(200).json({ success: true, data: [], meta: { page: 1, limit: 0, total: 0, pages: 1 } });
  } else if (scopeWallet) {
    query.$or = [{ buyer: scopeWallet }, { seller: scopeWallet }];
  }

  if (req.query.listingId != null) {
    const id = Number(req.query.listingId);
    if (Number.isInteger(id) && id >= 0) query.listingId = id;
  }

  if (req.query.verificationStatus && VERIFICATION_STATUSES.has(req.query.verificationStatus)) {
    query.verificationStatus = req.query.verificationStatus;
  }

  if (req.query.mismatchFlag && MISMATCH_FLAGS.has(req.query.mismatchFlag)) {
    query.mismatchFlags = req.query.mismatchFlag;
  }

  if (req.query.txHash) {
    const t = String(req.query.txHash).trim().toLowerCase();
    if (/^0x[a-f0-9]{64}$/.test(t)) query.txHash = t;
  }

  const { page, limit, skip } = parsePagination(req.query, { maxLimit: 100 });
  const [data, total] = await Promise.all([
    Settlement.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Settlement.countDocuments(query),
  ]);

  res.status(200).json({ success: true, data, meta: paginateResults({ page, limit, total }) });
});

/**
 * GET /api/v1/settlements/:id
 */
const getSettlement = asyncHandler(async (req, res) => {
  const id = String(req.params.id || '');
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid settlement id' });
  }

  const settlement = await Settlement.findById(id).lean();
  if (!settlement) {
    return res.status(404).json({ success: false, message: 'Settlement not found' });
  }

  // Ownership check for non-admins. A wallet-less user (wallet == '') is denied
  // outright rather than bypassing the party check via short-circuit.
  const wallet = String(req.user?.walletAddress || '').toLowerCase();
  if (
    !isAdmin(req) &&
    (!wallet || (settlement.buyer !== wallet && settlement.seller !== wallet))
  ) {
    return res.status(403).json({ success: false, message: 'Not authorized to view this settlement' });
  }

  res.status(200).json({ success: true, data: settlement });
});

/**
 * POST /api/v1/settlements/verify
 * Submit a txHash + listingId for on-chain receipt verification.
 */
const verifySettlement = asyncHandler(async (req, res) => {
  const { txHash, listingId } = req.body || {};

  let result;
  try {
    result = await settlementVerificationService.verifyPurchase(txHash, listingId);
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message,
      code: err.code || 'VERIFICATION_FAILED',
    });
  }

  const settlement = await settlementVerificationService.persistVerification(result, {
    actor: req.user,
    req,
  });

  res.status(200).json({
    success: true,
    data: {
      result,
      settlement,
    },
  });
});

/**
 * GET /api/v1/admin/settlements/mismatches  (admin/moderator only)
 * Lists settlements that are mismatched/disputed or flagged.
 */
const listMismatches = asyncHandler(async (req, res) => {
  const query = {
    $or: [
      { verificationStatus: { $in: ['mismatch', 'disputed'] } },
      { mismatchFlags: { $exists: true, $ne: [] } },
    ],
  };

  if (req.query.flag && MISMATCH_FLAGS.has(req.query.flag)) {
    delete query.$or;
    query.mismatchFlags = req.query.flag;
  }

  const { page, limit, skip } = parsePagination(req.query, { maxLimit: 100 });
  const [data, total] = await Promise.all([
    Settlement.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Settlement.countDocuments(query),
  ]);

  res.status(200).json({ success: true, data, meta: paginateResults({ page, limit, total }) });
});

/**
 * POST /api/v1/admin/settlements/reconcile  (admin only)
 * Manually trigger a reconciliation tick.
 */
const triggerReconcile = asyncHandler(async (req, res) => {
  const created = await reconciliationService.ensureSettlementsForPurchases();
  const summary = await reconciliationService.runReconciliation();
  res.status(200).json({ success: true, data: { ...summary, settlementsCreated: created } });
});

module.exports = {
  listSettlements,
  getSettlement,
  verifySettlement,
  listMismatches,
  triggerReconcile,
};
