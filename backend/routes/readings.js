const express = require('express');
const router = express.Router();
const {
  createReading,
  getReadings,
} = require('../controllers/readingController');
const { protect, authorize } = require('../middleware/auth');

router.route('/')
  .post(protect, authorize('admin'), createReading)
  .get(protect, getReadings);

module.exports = router;
