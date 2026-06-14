const express = require('express');
const router = express.Router();
const {
  getHistory,
  getByTxHash,
  syncAndGetHistory,
} = require('../controllers/tradesController');
const { protect, authorize } = require('../middleware/auth');

router.get('/history', protect, getHistory);
router.get('/history/sync', protect, authorize('admin'), syncAndGetHistory);
router.post('/history/sync', protect, authorize('admin'), syncAndGetHistory);
router.get('/tx/:txHash', protect, getByTxHash);

module.exports = router;
