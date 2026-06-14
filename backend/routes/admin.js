const express = require('express');
const router = express.Router();
const { authorize } = require('../middleware/auth');
const { createAdminRateLimiter } = require('../middleware/rateLimit');

const adminUserController = require('../controllers/admin/adminUserController');
const adminNodeController = require('../controllers/admin/adminNodeController');
const adminTradeController = require('../controllers/admin/adminTradeController');
const adminSyncController = require('../controllers/admin/adminSyncController');
const adminReportJobController = require('../controllers/admin/adminReportJobController');
const adminAuditController = require('../controllers/admin/adminAuditController');
const adminHealthController = require('../controllers/admin/adminHealthController');
const adminSimulatorController = require('../controllers/admin/adminSimulatorController');

router.use(authorize('admin', 'moderator'));
router.use(createAdminRateLimiter());

const adminOnly = authorize('admin');

router.get('/users', adminUserController.listUsers);
router.get('/users/:id', adminUserController.getUser);
router.patch('/users/:id/role', adminOnly, adminUserController.setRole);
router.patch('/users/:id/ban', adminOnly, adminUserController.banUser);
router.patch('/users/:id/unban', adminOnly, adminUserController.unbanUser);
router.delete('/users/:id', adminOnly, adminUserController.deleteUser);

router.get('/nodes', adminNodeController.listNodes);
router.post('/nodes', adminOnly, adminNodeController.createNode);
router.put('/nodes/:id', adminOnly, adminNodeController.updateNode);
router.delete('/nodes/:id', adminOnly, adminNodeController.deleteNode);

router.get('/trades', adminTradeController.listTrades);
router.get('/trades/:txHash', adminTradeController.getTrade);

router.get('/sync/status', adminSyncController.getSyncStatus);
router.post('/sync/force', adminOnly, adminSyncController.forceSync);

router.get('/report-jobs', adminReportJobController.listReportJobs);
router.get('/report-jobs/:id', adminReportJobController.getReportJob);
router.post('/report-jobs/:id/retry', adminOnly, adminReportJobController.retryReportJob);

router.get('/audit-logs', adminAuditController.listAuditLogs);

router.get('/health', adminHealthController.getHealth);

// Simulator (Phase 6)
router.get('/simulator/config', adminSimulatorController.getConfig);
router.put('/simulator/config', adminOnly, adminSimulatorController.updateConfig);
router.post('/simulator/restart', adminOnly, adminSimulatorController.restart);
router.post('/simulator/reset', adminOnly, adminSimulatorController.resetConfig);
router.get('/simulator/readings', adminSimulatorController.getRecentReadings);
router.get('/simulator/preview', adminSimulatorController.getPreview);

module.exports = router;
