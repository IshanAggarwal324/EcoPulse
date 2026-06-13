const express = require('express');
const router = express.Router();
const {
  getSummary,
  getEnergyAnalytics,
  getNodeAnalytics,
  getTradeAnalytics,
  getCarbonAnalytics,
  getCarbonBalanceAnalytics,
  syncBlockchain,
  getPlatformStatus,
} = require('../controllers/analyticsController');
const { protect, authorize } = require('../middleware/auth');

router.get('/summary', getSummary);
router.get('/energy', getEnergyAnalytics);
router.get('/nodes', getNodeAnalytics);
router.get('/trades', getTradeAnalytics);
router.get('/carbon', getCarbonAnalytics);
router.get('/carbon/balance', getCarbonBalanceAnalytics);
router.get('/status', getPlatformStatus);
router.post('/sync', protect, authorize('admin'), syncBlockchain);

module.exports = router;
