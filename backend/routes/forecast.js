const router = require('express').Router();
const { getForecast } = require('../controllers/forecastController');

router.get('/', getForecast);

module.exports = router;
