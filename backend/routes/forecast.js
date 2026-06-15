const router = require('express').Router();
const { getForecast } = require('../controllers/forecastController');
const { protect } = require('../middleware/auth');
const { createForecastRateLimiter } = require('../middleware/rateLimit');

const forecastLimiter = createForecastRateLimiter();

router.get('/', protect, forecastLimiter, getForecast);

module.exports = router;
