const express = require('express');
const router = express.Router();
const { authorize } = require('../middleware/auth');
const { createAdminRateLimiter } = require('../middleware/rateLimit');
const simulatorLockdown = require('../middleware/simulatorLockdown');

const adminUserController = require('../controllers/admin/adminUserController');
const adminNodeController = require('../controllers/admin/adminNodeController');
const adminTradeController = require('../controllers/admin/adminTradeController');
const adminSyncController = require('../controllers/admin/adminSyncController');
const adminReportJobController = require('../controllers/admin/adminReportJobController');
const adminAuditController = require('../controllers/admin/adminAuditController');
const adminHealthController = require('../controllers/admin/adminHealthController');
const adminSimulatorController = require('../controllers/admin/adminSimulatorController');
const adminDeviceController = require('../controllers/admin/adminDeviceController');
const adminIngestionController = require('../controllers/admin/adminIngestionController');
const adminTimeseriesController = require('../controllers/admin/adminTimeseriesController');
const adminMarketplaceController = require('../controllers/admin/adminMarketplaceController');
const adminAssistantController = require('../controllers/admin/adminAssistantController');

router.use(authorize('admin', 'moderator'));
router.use(createAdminRateLimiter());

const adminOnly = authorize('admin');

router.get('/users', adminOnly, adminUserController.listUsers);
router.get('/users/:id', adminOnly, adminUserController.getUser);
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

router.get('/report-jobs', adminOnly, adminReportJobController.listReportJobs);
router.get('/report-jobs/:id', adminOnly, adminReportJobController.getReportJob);
router.post('/report-jobs/:id/retry', adminOnly, adminReportJobController.retryReportJob);

router.get('/audit-logs', adminOnly, adminAuditController.listAuditLogs);
router.get('/audit-logs/verify', adminOnly, adminAuditController.verifyAuditIntegrity);

router.get('/health', adminHealthController.getHealth);

// Simulator (Phase 6). Mutation routes are guarded by the ingestion-mode
// lockdown (Sub-module 1.4.1): 403 in production public_api/device mode.
router.get('/simulator/config', adminSimulatorController.getConfig);
router.put('/simulator/config', adminOnly, simulatorLockdown, adminSimulatorController.updateConfig);
router.post('/simulator/restart', adminOnly, simulatorLockdown, adminSimulatorController.restart);
router.post('/simulator/reset', adminOnly, simulatorLockdown, adminSimulatorController.resetConfig);
router.get('/simulator/readings', adminSimulatorController.getRecentReadings);
router.get('/simulator/preview', adminSimulatorController.getPreview);

// Sub-module 1.1 — Device Registry & Authentication
router.use('/devices', adminOnly, require('./devices'));

// Module 4.2.7 — Model version lifecycle (versions, compare, drift, promote)
router.use('/models', adminOnly, require('./admin/adminModels'));

// Sub-module 1.2.7 — Ingestion observability (counters, dead-letters, MQTT status)
router.get('/ingestion/health', adminIngestionController.getIngestionHealth);
router.get('/ingestion/errors', adminOnly, adminIngestionController.listIngestionErrors);

// Sub-module 1.4 — Ingestion mode, unified dashboard, and historical backfill.
router.get('/ingestion/mode', adminIngestionController.getIngestionMode);
router.get('/ingestion/dashboard', adminIngestionController.getIngestionDashboard);
router.post('/ingestion/backfill', adminOnly, adminIngestionController.backfill);

// Sub-module 1.3 — Time-series status + manual rollup trigger
router.get('/ingestion/timeseries/status', adminTimeseriesController.getStatus);
router.post('/ingestion/timeseries/rollup', adminOnly, adminTimeseriesController.triggerRollup);

// Sub-module 1.5.5 — Public grid source admin surface (CRUD + poll-now + reset)
router.use('/public-grid-sources', adminOnly, require('./adminPublicGrid'));

// Sub-module 2.3 — Auto-trading kill switch + matcher observability
router.use('/auto-trading', require('./adminAutoTrading'));

// Sub-module 2.4 guardrail — marketplace (contract) emergency stop
router.get('/marketplace/status', adminMarketplaceController.getStatus);
router.post('/marketplace/pause', adminOnly, adminMarketplaceController.pause);
router.post('/marketplace/resume', adminOnly, adminMarketplaceController.resume);

// Sub-module 3.1.4 — assistant doc RAG reindex (admin + internal key only)
router.post('/assistant/reindex', adminOnly, adminAssistantController.reindexAssistant);

// Sub-module 3.4.2 — aggregated assistant chat analytics
router.get('/assistant/analytics', adminAssistantController.getAssistantAnalytics);

module.exports = router;
