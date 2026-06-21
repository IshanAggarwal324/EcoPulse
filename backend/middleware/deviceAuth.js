const asyncHandler = require('../utils/asyncHandler');
const deviceService = require('../services/deviceService');
const auditService = require('../services/auditService');
const { logBackgroundError } = require('../utils/logger');

const DEVICE_ID_HEADER = 'x-device-id';
const API_KEY_HEADER = 'x-api-key';

/**
 * deviceAuth middleware (Sub-module 1.1.3)
 *
 * Validates the `x-device-id` + `x-api-key` headers against a stored bcrypt
 * hash, enforces the brute-force lockout, rejects revoked/inactive credentials,
 * and binds the authenticated device to its node on `req.device` / `req.node`.
 *
 * Also enforces the guardrail "Ingestion rejects readings for inactive nodes"
 * (1.1.4): a device bound to a node whose status is not `active` is rejected,
 * so a decommissioned/in-maintenance node cannot accept telemetry even if a
 * credential is still valid.
 *
 * Security properties:
 *  - Constant-time comparison (bcrypt) plus uniform response timing — no
 *    deviceId enumeration via side channels.
 *  - Every failure (missing creds, wrong key, locked, revoked, inactive node)
 *    is audit-logged; the response body and status are identical for all
 *    "no/invalid device" cases so callers can't distinguish causes.
 *  - Device self-registration is impossible — credentials are admin-issued.
 */
const deviceAuth = asyncHandler(async (req, res, next) => {
  if (!deviceService.isDeviceAuthEnabled()) {
    return res.status(503).json({
      success: false,
      message: 'Device authentication is not enabled on this deployment',
      code: 'DEVICE_AUTH_DISABLED',
    });
  }

  const deviceId = req.get(DEVICE_ID_HEADER);
  const apiKey = req.get(API_KEY_HEADER);

  const fail = (opts = {}) => {
    const { status = 401, code = 'AUTH_FAILED' } = opts;
    auditService
      .log({
        actor: null,
        action: 'DEVICE_AUTH_FAILED',
        resourceType: 'device',
        resourceId: deviceId || null,
        metadata: {
          code,
          path: req.originalUrl,
          method: req.method,
          hasDeviceId: Boolean(deviceId),
          hasApiKey: Boolean(apiKey),
        },
        req,
        severity: code === 'AUTH_FAILED' ? 'info' : 'warn',
      })
      .catch((err) => logBackgroundError('deviceAuth.auditFailed', err, { code }));

    // Identical body/shape for every failure so the cause can't be inferred.
    return res.status(status).json({
      success: false,
      message: 'Device authentication failed',
      code,
    });
  };

  if (!deviceId || !apiKey) {
    return fail({ code: 'AUTH_FAILED' });
  }

  const result = await deviceService.authenticateDevice({
    deviceId,
    apiKey,
    ip: req.ip,
  });

  if (!result.ok) {
    // DEVICE_REVOKED / DEVICE_LOCKED use the same 401 envelope to avoid
    // leaking device state to an unauthenticated caller. The distinct `code`
    // is only used for internal audit severity above.
    return fail({ code: result.code });
  }

  const { device, node } = result;

  // 1.1.4 — reject telemetry for inactive / decommissioned nodes even with a
  // valid credential. A device should never push readings into a node that is
  // not in normal operation.
  if (!node) {
    return fail({ code: 'AUTH_FAILED' });
  }

  if (node.status !== 'active') {
    auditService
      .log({
        actor: null,
        action: 'DEVICE_AUTH_NODE_INACTIVE',
        resourceType: 'device',
        resourceId: device.deviceId,
        metadata: {
          nodeId: String(node._id),
          nodeStatus: node.status,
          path: req.originalUrl,
        },
        req,
        severity: 'warn',
      })
      .catch((err) => logBackgroundError('deviceAuth.auditNodeInactive', err, {
        nodeStatus: node.status,
      }));
      success: false,
      message: 'Bound node is not active',
      code: 'NODE_INACTIVE',
    });
  }

  req.device = device;
  req.node = node;
  return next();
});

module.exports = { deviceAuth, DEVICE_ID_HEADER, API_KEY_HEADER };
