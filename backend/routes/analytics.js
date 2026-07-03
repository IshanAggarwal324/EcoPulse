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
const { getEnergyFlow } = require('../controllers/flowController');

router.get('/summary', protect, getSummary);
// Module 9.1 — energy/carbon flow Sankey graph. Available to all authenticated
// users but scoped to the caller's own wallet (controller/service enforces);
// admin/moderator may view the global marketplace flow.
router.get('/energy-flow', protect, getEnergyFlow);
router.get('/energy', protect, authorize('admin', 'moderator'), getEnergyAnalytics);
router.get('/nodes', protect, authorize('admin', 'moderator'), getNodeAnalytics);
router.get('/trades', protect, authorize('admin', 'moderator'), getTradeAnalytics);
router.get('/carbon', protect, getCarbonAnalytics);
router.get('/carbon/balance', protect, getCarbonBalanceAnalytics);
router.get('/status', protect, authorize('admin', 'moderator'), getPlatformStatus);
router.post('/sync', protect, authorize('admin'), syncBlockchain);

module.exports = router;
