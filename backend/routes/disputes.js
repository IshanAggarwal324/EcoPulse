const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { createApiRateLimiter, createRateLimiter } = require('../middleware/rateLimit');
const { listDisputes, getDispute, submitEvidence, resolveDispute } = require('../controllers/disputeController');

const router = express.Router();
const apiRateLimit = createApiRateLimiter();

// Stricter limiter for dispute-evidence submissions (anti-spam).
const evidenceRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: parseInt(process.env.DISPUTE_EVIDENCE_RATE_LIMIT_MAX || '20', 10),
  message: 'Too many evidence submissions. Please try again later.',
});

router.get('/', protect, apiRateLimit, listDisputes);
router.get('/:disputeId', protect, getDispute);
router.post('/:disputeId/evidence', protect, apiRateLimit, evidenceRateLimit, submitEvidence);
// Admin/moderator on-chain resolution. NOTE: in production, prefer resolving
// directly from a multisig that holds ARBITER_ROLE.
router.post('/:disputeId/resolve', protect, authorize('admin'), resolveDispute);

module.exports = router;
