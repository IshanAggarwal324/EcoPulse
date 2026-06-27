/**
 * Marketplace settlement status surface — Module 6.4.3
 *
 * Buyer/seller-facing views of the settlement lifecycle. Every handler is
 * HARD-SCOPED to the caller's wallet: a user can only ever see settlements in
 * which they are the buyer or seller. There is no unscoped read path here —
 * admins use the /admin/settlements surface instead.
 */

const mongoose = require('mongoose');
const Settlement = require('../models/Settlement');
const { parsePagination, paginateResults } = require('../utils/paginate');
const asyncHandler = require('../utils/asyncHandler');
const { resolveEscrowBatch, resolveEscrowForSettlement } = require('../services/settlementEscrowService');
const { buildTimeline } = require('../services/settlementLifecycleService');

const VERIFICATION_STATUSES = new Set(Settlement.VERIFICATION_STATUSES);
const MISMATCH_FLAGS = new Set(Settlement.MISMATCH_FLAGS);

const walletOf = (req) => String(req.user?.walletAddress || '').toLowerCase();

const isParty = (doc, wallet) => !!doc && (doc.buyer === wallet || doc.seller === wallet);

const enrich = (doc, escrow) => {
  const { current, steps } = buildTimeline(doc, escrow);
  return { ...doc, escrowState: escrow?.state || null, lifecycle: { current, steps } };
};

/**
 * GET /api/v1/marketplace/settlements
 * List the caller's settlements (buyer or seller).
 */
const listMySettlements = asyncHandler(async (req, res) => {
  const wallet = walletOf(req);
  if (!wallet) {
    return res.status(200).json({
      success: true,
      data: [],
      meta: { page: 1, limit: 0, total: 0, pages: 1 },
    });
  }

  const query = { $or: [{ buyer: wallet }, { seller: wallet }] };

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
  const [rows, total] = await Promise.all([
    Settlement.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Settlement.countDocuments(query),
  ]);
  const escrowMap = await resolveEscrowBatch(rows);
  const data = rows.map((r) => enrich(r, escrowMap.get(String(r._id)) || null));

  res.status(200).json({ success: true, data, meta: paginateResults({ page, limit, total }) });
});

/**
 * GET /api/v1/marketplace/settlements/:tradeId
 * :tradeId resolves to a settlement by its own _id or by tradeRef (Trade _id).
 */
const getMySettlement = asyncHandler(async (req, res) => {
  const wallet = walletOf(req);
  const tradeId = String(req.params.tradeId || '');

  let doc = null;
  if (mongoose.Types.ObjectId.isValid(tradeId)) {
    doc = await Settlement.findOne({ $or: [{ _id: tradeId }, { tradeRef: tradeId }] }).lean();
  }
  if (!doc) {
    return res.status(404).json({ success: false, message: 'Settlement not found' });
  }
  if (!isParty(doc, wallet)) {
    return res.status(403).json({ success: false, message: 'Not authorized to view this settlement' });
  }

  const escrow = await resolveEscrowForSettlement(doc);
  res.status(200).json({ success: true, data: enrich(doc, escrow) });
});

/**
 * GET /api/v1/marketplace/orders/:listingId/settlement
 * Latest settlement for an order the caller is a party to.
 */
const getSettlementForOrder = asyncHandler(async (req, res) => {
  const wallet = walletOf(req);
  const listingId = Number(req.params.listingId);
  if (!Number.isInteger(listingId) || listingId < 0) {
    return res.status(400).json({ success: false, message: 'Invalid listingId' });
  }

  const doc = await Settlement.findOne({
    listingId,
    $or: [{ buyer: wallet }, { seller: wallet }],
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!doc) {
    return res.status(404).json({ success: false, message: 'No settlement found for this order' });
  }

  const escrow = await resolveEscrowForSettlement(doc);
  res.status(200).json({ success: true, data: enrich(doc, escrow) });
});

module.exports = { listMySettlements, getMySettlement, getSettlementForOrder };
