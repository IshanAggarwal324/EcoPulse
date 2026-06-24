const router = require('express').Router();
const { getForecast, getForecastConfidence } = require('../controllers/forecastController');
const { protect } = require('../middleware/auth');
const { createForecastRateLimiter } = require('../middleware/rateLimit');

const forecastLimiter = createForecastRateLimiter();

router.get('/confidence', protect, forecastLimiter, getForecastConfidence);
router.get('/', protect, forecastLimiter, getForecast);

module.exports = router;
