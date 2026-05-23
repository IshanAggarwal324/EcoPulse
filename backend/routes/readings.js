const express = require('express');
const router = express.Router();
const {
  createReading,
  getReadings,
} = require('../controllers/readingController');

router.route('/')
  .post(createReading)
  .get(getReadings);

module.exports = router;
