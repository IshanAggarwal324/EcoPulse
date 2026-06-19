const asyncHandler = require('../utils/asyncHandler');
const { processDeviceTelemetry } = require('../services/ingestion/telemetryService');

/**
 * HTTP push fallback for devices without MQTT (Sub-module 1.2.5).
 *
 * Route: POST /api/v1/telemetry
 * Auth:  deviceAuth middleware (x-device-id + x-api-key), not a user JWT.
 * Limiter: createDeviceTelemetryRateLimiter (per-device tier).
 *
 * req.device and req.node are populated by deviceAuth. The body is validated,
 * deduped, capacity-checked, and ingested via the unified pipeline.
 */
const ingestTelemetry = asyncHandler(async (req, res) => {
  // Body size is already capped globally (1mb) and we additionally enforce a
  // telemetry-specific 4 KB ceiling in the route via a dedicated check.
  const result = await processDeviceTelemetry({
    device: req.device,
    node: req.node,
    payload: req.body,
    transport: 'http',
    ip: req.ip,
  });

  if (!result.ok) {
    // Duplicate / validation failures are 4xx; ingest errors are 5xx.
    const status = result.code === 'INGEST_ERROR' ? 503 : 422;
    return res.status(status).json({
      success: false,
      message: result.reason || 'Telemetry rejected',
      code: result.code,
    });
  }

  return res.status(202).json({
    success: true,
    message: 'Telemetry accepted',
    data: { readingId: result.reading?._id || null },
  });
});

module.exports = { ingestTelemetry };
