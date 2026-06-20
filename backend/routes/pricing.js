const router = require('express').Router();
const { getPricingCurve, getRecommendations } = require('../controllers/pricingController');
const { protect } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

// Pricing curve is forecast-heavy and Redis-cached (5-min TTL), so a modest
// per-user limit prevents forecast spam against the AI service.
const pricingLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: parseInt(process.env.PRICING_RATE_LIMIT_MAX || '30', 10),
  message: 'Pricing rate limit exceeded. Curves are cached for 5 minutes.',
});

router.get('/curve', protect, pricingLimiter, getPricingCurve);
router.get('/recommendations', protect, pricingLimiter, getRecommendations);

module.exports = router;
