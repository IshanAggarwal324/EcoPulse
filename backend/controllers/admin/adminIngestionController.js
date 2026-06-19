const asyncHandler = require('../../utils/asyncHandler');
const ingestionMetrics = require('../../services/ingestion/ingestionMetrics');
const mqttIngestionService = require('../../services/mqtt/mqttIngestionService');
const { parsePagination, paginateResults } = require('../../utils/paginate');
const IngestionError = require('../../models/IngestionError');

/**
 * Ingestion observability surface (Sub-module 1.2.7).
 *
 * GET /admin/ingestion/health   — counters + per-device/provider last-seen +
 *                                 MQTT status + recent dead-letter stats
 * GET /admin/ingestion/errors   — paginated dead-letter (IngestionError) list
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

module.exports = { getIngestionHealth, listIngestionErrors };
