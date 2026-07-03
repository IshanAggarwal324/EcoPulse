const express = require('express');
const router = express.Router();
const {
  getHistory,
  getByTxHash,
  syncAndGetHistory,
  getRecent,
} = require('../controllers/tradesController');
const { protect, authorize } = require('../middleware/auth');

// Module 9.4 — anonymized global ticker seed (auth + rate-limit inherited from
// the /api/v1/trades mount in routes/v1.js).
router.get('/recent', protect, getRecent);
router.get('/history', protect, getHistory);
router.get('/history/sync', protect, authorize('admin'), syncAndGetHistory);
router.post('/history/sync', protect, authorize('admin'), syncAndGetHistory);
router.get('/tx/:txHash', protect, getByTxHash);

module.exports = router;
