const router = require('express').Router();
const { authorize } = require('../middleware/auth');
const controller = require('../controllers/admin/adminAutoTradingController');

/**
 * Admin auto-trading routes (Sub-module 2.3 — kill switch + observability).
 * Mounted under /api/v1/admin which already enforces authorize('admin','moderator').
 * Mutation routes are restricted to the `admin` role.
 */
const adminOnly = authorize('admin');

router.get('/status', controller.getStatus);
router.get('/analytics', controller.getAnalytics);
router.post('/pause', adminOnly, controller.pause);
router.post('/resume', adminOnly, controller.resume);
router.post('/run', adminOnly, controller.runOnce);

module.exports = router;
