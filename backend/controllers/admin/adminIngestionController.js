const asyncHandler = require('../../utils/asyncHandler');
const ingestionMetrics = require('../../services/ingestion/ingestionMetrics');
const mqttIngestionService = require('../../services/mqtt/mqttIngestionService');
const { parsePagination, paginateResults } = require('../../utils/paginate');
const IngestionError = require('../../models/IngestionError');
const ingestionMode = require('../../config/ingestionMode');
const simulatorManager = require('../../services/simulatorManager');
const DeviceCredential = require('../../models/DeviceCredential');
const backfillService = require('../../services/ingestion/backfillService');
const auditService = require('../../services/auditService');

/**
 * Dynamically detect the optional public-grid subsystem (Sub-module 1.5). It is
 * not built yet, so the dashboard must degrade gracefully: when the module is
 * absent, the "Public API pollers" section reports `available: false`. Once 1.5
 * lands, this same code surfaces live poller status with zero changes.
 */
const loadPublicGridSurface = () => {
  try {
    // eslint-disable-next-line global-require
    const publicGridService = require('../../services/publicGrid/publicGridService');
    // eslint-disable-next-line global-require
    const PublicGridSource = require('../../models/PublicGridSource');
    return { publicGridService, PublicGridSource, available: true };
  } catch {
    return { publicGridService: null, PublicGridSource: null, available: false };
  }
};

/**
 * Ingestion observability surface (Sub-module 1.2.7).
 *
 * GET /admin/ingestion/health   — counters + per-device/provider last-seen +
 *                                 MQTT status + recent dead-letter stats
 * GET /admin/ingestion/errors   — paginated dead-letter (IngestionError) list
 * GET /admin/ingestion/mode     — resolved ingestion mode + capabilities + lockdowns (1.4.1)
 * GET /admin/ingestion/dashboard— unified simulator/device/public-api view (1.4.2)
 * POST /admin/ingestion/backfill— historical import (1.4.3)
 */

const getIngestionHealth = asyncHandler(async (req, res) => {
  const { sinceHours } = req.query;
  const hours = Math.min(Math.max(parseInt(sinceHours, 10) || 24, 1), 168);

  const [snapshot, errorStats] = await Promise.all([
    ingestionMetrics.getSnapshot(),
    ingestionMetrics.getErrorStats({ sinceHours: hours }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      metrics: snapshot,
      deadLetters: errorStats,
      mqtt: mqttIngestionService.getStatus(),
    },
  });
});

const listIngestionErrors = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { maxLimit: 100, defaultLimit: 50 });
  const filter = {};

  if (req.query.kind && IngestionError.VALID_KINDS.includes(req.query.kind)) {
    filter.kind = req.query.kind;
  }
  if (req.query.source && ['mqtt', 'http', 'poller'].includes(req.query.source)) {
    filter.source = req.query.source;
  }
  if (req.query.deviceId) {
    filter.deviceId = String(req.query.deviceId);
  }

  const [errors, total] = await Promise.all([
    IngestionError.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    IngestionError.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: errors,
    meta: paginateResults({ page, limit, total }),
  });
});

// Sub-module 1.4.1 — resolved mode + capabilities + lockdown flags.
const getIngestionMode = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: ingestionMode.getStatus() });
});

// Sub-module 1.4.2 — unified ingestion dashboard (three sections).
const getIngestionDashboard = asyncHandler(async (req, res) => {
  const { publicGridService, PublicGridSource, available: publicGridAvailable } =
    loadPublicGridSurface();

  // Device telemetry counts (subsystem may be disabled — still report zeros).
  let deviceSummary = { total: 0, active: 0 };
  try {
    const [total, active] = await Promise.all([
      DeviceCredential.countDocuments({}),
      DeviceCredential.countDocuments({ status: 'active' }),
    ]);
    deviceSummary = { total, active };
  } catch {
    /* DeviceCredential unavailable — leave defaults */
  }

  // Public grid pollers (optional subsystem).
  let publicApi = { available: publicGridAvailable, sources: [], enabled: 0 };
  if (publicGridAvailable && PublicGridSource) {
    try {
      const [sources, enabled] = await Promise.all([
        PublicGridSource.find({}).lean(),
        PublicGridSource.countDocuments({ enabled: true }),
      ]);
      const pollerStatus = publicGridService?.getPollerStatus?.() || {};
      publicApi = {
        available: true,
        enabled,
        poller: pollerStatus,
        sources: sources.map((s) => ({
          _id: s._id,
          providerKey: s.providerKey,
          displayName: s.displayName,
          enabled: s.enabled,
          lastPollAt: s.lastPollAt || null,
          lastError: s.lastError || null,
        })),
      };
    } catch {
      publicApi = { available: true, sources: [], enabled: 0, error: 'status unavailable' };
    }
  }

  const snapshot = ingestionMetrics.getSnapshot();

  res.status(200).json({
    success: true,
    data: {
      mode: ingestionMode.getStatus(),
      simulator: simulatorManager.getStatus(),
      devices: {
        ...deviceSummary,
        mqtt: mqttIngestionService.getStatus(),
        authEnabled: String(process.env.DEVICE_AUTH_ENABLED || '').toLowerCase() === 'true',
        recent: snapshot.recentDevices,
      },
      publicApi,
      metrics: {
        counters: snapshot.counters,
        bySource: snapshot.bySource,
        byTransport: snapshot.byTransport,
      },
    },
  });
});

// Sub-module 1.4.3 — historical backfill / replay (admin-only, audited).
const backfill = asyncHandler(async (req, res) => {
  const { defaultSource, dryRun, confirmSimulated } = req.body || {};

  const result = await backfillService.runBackfill({
    body: req.body,
    defaultSource,
    dryRun: !!dryRun,
    confirmSimulated: !!confirmSimulated,
    actor: req.user,
  });

  await auditService.log({
    actor: req.user,
    action: 'INGESTION_BACKFILL',
    resourceType: 'ingestion',
    resourceId: null,
    metadata: {
      requested: result.requested,
      accepted: result.accepted,
      rejected: result.rejected,
      dryRun: result.dryRun,
      bySource: result.bySource,
      defaultSource: defaultSource || 'public_api',
    },
    req,
    severity: result.accepted > 0 ? 'warn' : 'info',
  });

  res.status(200).json({ success: true, data: result });
});

module.exports = {
  getIngestionHealth,
  listIngestionErrors,
  getIngestionMode,
  getIngestionDashboard,
  backfill,
};
