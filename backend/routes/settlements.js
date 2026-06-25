const express = require('express');
const { protect } = require('../middleware/auth');
const { createApiRateLimiter, createRateLimiter } = require('../middleware/rateLimit');
const {
  listSettlements,
  getSettlement,
  verifySettlement,
} = require('../controllers/settlementController');

const router = express.Router();
const apiRateLimit = createApiRateLimiter();

// Receipt verification issues multiple RPC calls (receipt + block + listing
// read); bound it more tightly than the generic API limiter to prevent abuse.
const verifyRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: parseInt(process.env.SETTLEMENT_VERIFY_RATE_LIMIT_MAX || '10', 10),
  message: 'Too many settlement verification requests. Please try again later.',
});

router.get('/', protect, apiRateLimit, listSettlements);
router.get('/:id', protect, apiRateLimit, getSettlement);
router.post('/verify', protect, apiRateLimit, verifyRateLimit, verifySettlement);

module.exports = router;
