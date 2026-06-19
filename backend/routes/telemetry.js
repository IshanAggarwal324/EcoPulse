const express = require('express');
const router = express.Router();
const { deviceAuth } = require('../middleware/deviceAuth');
const { createDeviceTelemetryRateLimiter } = require('../middleware/deviceRateLimit');
const { ingestTelemetry } = require('../controllers/telemetryController');

// Sub-module 1.2.5 — HTTP push fallback for devices without MQTT.
// Auth is device-based (x-device-id / x-api-key), NOT a user JWT, so this route
// is mounted standalone in v1.js outside the guardedUser chain.
const PAYLOAD_MAX_BYTES = parseInt(process.env.TELEMETRY_MAX_BYTES || '4096', 10);

// Guardrail 1.2: payload size cap (default 4 KB) — rejects oversized bodies
// before they reach JSON parsing or the validator.
const payloadSizeCap = (req, res, next) => {
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > PAYLOAD_MAX_BYTES) {
    return res.status(413).json({
      success: false,
      message: `Telemetry payload exceeds ${PAYLOAD_MAX_BYTES} byte limit`,
      code: 'PAYLOAD_TOO_LARGE',
    });
  }
  next();
};

router.post(
  '/',
  payloadSizeCap,
  deviceAuth,
  createDeviceTelemetryRateLimiter(),
  ingestTelemetry,
);

module.exports = router;
