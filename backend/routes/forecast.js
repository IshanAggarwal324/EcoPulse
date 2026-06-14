const router = require('express').Router();
const { getForecast } = require('../controllers/forecastController');
const { protect } = require('../middleware/auth');

router.get('/', protect, getForecast);

module.exports = router;
