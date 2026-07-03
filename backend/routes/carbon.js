const express = require('express');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { createApiRateLimiter } = require('../middleware/rateLimit');
const P = require('../auth/permissions');
const {
  indexRetirement,
  listRetirements,
  getBalance,
  getTotals,
  indexBridgeTransfer,
  listBridgeTransfers,
  awardCredits,
} = require('../controllers/carbonController');

const router = express.Router();
const apiRateLimit = createApiRateLimiter();

// Read-only carbon metrics.
router.get('/balance', protect, getBalance);
router.get('/totals', protect, getTotals);
router.get('/retirements', protect, listRetirements);
router.get('/bridge/transfers', protect, listBridgeTransfers);

// Client-signs, backend-indexes (idempotent).
router.post('/retirements', protect, apiRateLimit, indexRetirement);
router.post('/bridge/index', protect, apiRateLimit, indexBridgeTransfer);

// Mint-to-earn — privileged system/admin action only (Module 8.2 capability).
router.post('/award', protect, requirePermission(P.CARBON_AWARD), awardCredits);

module.exports = router;
