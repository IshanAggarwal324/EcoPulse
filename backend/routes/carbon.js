const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { createApiRateLimiter } = require('../middleware/rateLimit');
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

// Mint-to-earn — privileged system/admin action only.
router.post('/award', protect, authorize('admin'), awardCredits);

module.exports = router;
