/**
 * Settlement admin surface — Module 6.4.6
 *
 * Mismatch queue, dispute queue, unified lifecycle queue, and manual override.
 *
 * SECURITY NOTES
 *  - This controller performs NO auth checks itself; it relies on the router
 *    (`routes/admin.js`) applying `authorize('admin','moderator')` globally and
 *    `adminOnly` (authorize('admin')) on every mutation route that mounts it.
 *  - `overrideStatus` only ever sets `verificationStatus`. Escrow-driven truth
 *    (released/refunded) is intentionally NOT overridable from the UI — those
 *    are on-chain facts and must not be forgeable by an admin.
 *  - Every override is written to the append-only, hash-chained AuditLog at
 *    severity 'critical' with from/to/reason/actor captured.
 *  - The override target set is a strict allowlist (state machine); unknown or
 *    escrow-only targets are rejected with 400.
 */

const Settlement = require('../../models/Settlement');
const { parsePagination, paginateResults } = require('../../utils/paginate');
const asyncHandler = require('../../utils/asyncHandler');
const auditService = require('../../services/auditService');
const { resolveEscrowBatch } = require('../../services/settlementEscrowService');
const { buildTimeline } = require('../../services/settlementLifecycleService');

const VERIFICATION_STATUSES = new Set(Settlement.VERIFICATION_STATUSES);
const MISMATCH_FLAGS = new Set(Settlement.MISMATCH_FLAGS);

// Targets an admin may MANUALLY set verificationStatus to. Escrow-driven states
// (released/refunded) are excluded on purpose — see file header.
const OVERRIDE_TARGETS = new Set(['pending', 'verified', 'mismatch', 'disputed']);

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const TXHASH_RE = /^0x[a-f0-9]{64}$/;

const enrich = (doc, escrow) => {
  const { current, steps } = buildTimeline(doc, escrow);
  return { ...doc, escrowState: escrow?.state || null, lifecycle: { current, steps } };
};

/**
 * GET /api/v1/admin/settlements — unified queue with lifecycle/status filters.
 */
const listSettlementQueue = asyncHandler(async (req, res) => {
  const query = {};

  if (req.query.verificationStatus && VERIFICATION_STATUSES.has(req.query.verificationStatus)) {
    query.verificationStatus = req.query.verificationStatus;
  }
  if (req.query.flag && MISMATCH_FLAGS.has(req.query.flag)) {
    query.mismatchFlags = req.query.flag;
  }
  if (req.query.listingId != null) {
    const id = Number(req.query.listingId);
    if (Number.isInteger(id) && id >= 0) query.listingId = id;
  }
  if (req.query.wallet) {
    const w = String(req.query.wallet).trim().toLowerCase();
    if (WALLET_RE.test(w)) query.$or = [{ buyer: w }, { seller: w }];
  }
  if (req.query.autoFlagged === 'true') query.autoFlagged = true;
  if (req.query.txHash) {
    const t = String(req.query.txHash).trim().toLowerCase();
    if (TXHASH_RE.test(t)) query.txHash = t;
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
 * GET /api/v1/admin/settlements/disputes — dispute queue.
 */
const listDisputes = asyncHandler(async (req, res) => {
  const query = { verificationStatus: 'disputed' };
  const { page, limit, skip } = parsePagination(req.query, { maxLimit: 100 });
  const [rows, total] = await Promise.all([
    Settlement.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Settlement.countDocuments(query),
  ]);
  res.status(200).json({ success: true, data: rows, meta: paginateResults({ page, limit, total }) });
});

/**
 * POST /api/v1/admin/settlements/:id/override — manual status override.
 * Body: { target: 'pending'|'verified'|'mismatch'|'disputed', reason: string, flag?: mismatchFlag }
 */
const overrideStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { target, reason, flag } = req.body || {};

  if (!OVERRIDE_TARGETS.has(target)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid override target',
      code: 'INVALID_TARGET',
    });
  }
  const reasonStr = typeof reason === 'string' ? reason.trim() : '';
  if (reasonStr.length < 1 || reasonStr.length > 500) {
    return res.status(400).json({
      success: false,
      message: 'A reason (1–500 chars) is required',
      code: 'INVALID_REASON',
    });
  }

  const current = await Settlement.findById(id).lean();
  if (!current) {
    return res.status(404).json({ success: false, message: 'Settlement not found' });
  }

  // No-op / idempotency guard: don't churn the record or emit audit noise.
  if (current.verificationStatus === target) {
    return res.status(200).json({ success: true, message: 'No change', data: { settlement: current } });
  }

  const update = {
    $set: {
      verificationStatus: target,
      lastReconciledAt: new Date(),
      'evidence.adminOverride': {
        from: current.verificationStatus,
        to: target,
        reason: reasonStr,
        actorId: req.user?._id || null,
        actorEmail: req.user?.email || null,
        at: new Date().toISOString(),
      },
    },
  };
  if (MISMATCH_FLAGS.has(flag)) update.$addToSet = { mismatchFlags: flag };

  const updated = await Settlement.findByIdAndUpdate(id, update, { new: true }).lean();

  await auditService.log({
    actor: req.user,
    action: 'settlement.status_override',
    resourceType: 'settlement',
    resourceId: String(id),
    metadata: {
      listingId: current.listingId,
      from: current.verificationStatus,
      to: target,
      reason: reasonStr,
      flag: MISMATCH_FLAGS.has(flag) ? flag : undefined,
    },
    req,
    severity: 'critical',
  });

  res.status(200).json({ success: true, data: { settlement: updated } });
});

module.exports = { listSettlementQueue, listDisputes, overrideStatus, OVERRIDE_TARGETS };
