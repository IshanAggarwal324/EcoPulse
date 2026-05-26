const express = require('express');
const router = express.Router();
const {
  getHistory,
  getByTxHash,
  syncAndGetHistory,
} = require('../controllers/tradesController');

router.get('/history', getHistory);
router.get('/history/sync', syncAndGetHistory);
router.get('/tx/:txHash', getByTxHash);

module.exports = router;
