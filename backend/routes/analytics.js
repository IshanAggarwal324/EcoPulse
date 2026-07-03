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
const { requirePermission } = require('../middleware/requirePermission');
const P = require('../auth/permissions');
const { getEnergyFlow } = require('../controllers/flowController');

router.get('/summary', protect, getSummary);
// Module 9.1 — energy/carbon flow Sankey graph. Available to all authenticated
// users but scoped to the caller's own wallet (controller/service enforces);
// admin/moderator may view the global marketplace flow.
router.get('/energy-flow', protect, getEnergyFlow);

// Module 8.2 — global analytics. Granted to roles holding analytics:read:global
// (admin + moderator today). grid_operator holds analytics:read:zone (reserved
// for Module 8.3 zone-scoping) and is deliberately NOT granted the global view
// to avoid leaking platform-wide data before zone filters exist.
router.get('/energy', protect, requirePermission(P.ANALYTICS_READ_GLOBAL), getEnergyAnalytics);
router.get('/nodes', protect, requirePermission(P.ANALYTICS_READ_GLOBAL), getNodeAnalytics);
router.get('/trades', protect, requirePermission(P.ANALYTICS_READ_GLOBAL), getTradeAnalytics);
router.get('/carbon', protect, getCarbonAnalytics);
router.get('/carbon/balance', protect, getCarbonBalanceAnalytics);
router.get('/status', protect, requirePermission(P.ANALYTICS_READ_GLOBAL), getPlatformStatus);
// System sync is an admin mutation; kept on the role guard for clarity.
router.post('/sync', protect, authorize('admin'), syncBlockchain);

module.exports = router;
