const express = require('express');
const router = express.Router();
const {
  getSummary,
  getEnergyAnalytics,
  getNodeAnalytics,
  getTradeAnalytics,
  getCarbonAnalytics,
  syncBlockchain,
  getPlatformStatus,
} = require('../controllers/analyticsController');

router.get('/summary', getSummary);
router.get('/energy', getEnergyAnalytics);
router.get('/nodes', getNodeAnalytics);
router.get('/trades', getTradeAnalytics);
router.get('/carbon', getCarbonAnalytics);
router.get('/status', getPlatformStatus);
router.post('/sync', syncBlockchain);

module.exports = router;
