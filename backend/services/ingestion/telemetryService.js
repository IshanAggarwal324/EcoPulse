const readingService = require('../readingService');
const EnergyNode = require('../../models/EnergyNode');
const { validateEnvelope, checkCapacity } = require('./telemetrySchema');
const { checkAndMark } = require('./dedup');
const ingestionMetrics = require('./ingestionMetrics');

/**
 * Telemetry ingestion pipeline (Sub-modules 1.2.2, 1.2.3, 1.2.5, 1.2.6).
 *
 * Shared by the HTTP push endpoint (`POST /api/v1/telemetry`) and the MQTT
 * ingestion service. The device is already authenticated upstream (deviceAuth
 * middleware for HTTP; topic-ACL + broker auth for MQTT), so `device` + `node`
 * are passed in resolved.
 *
 * Returns `{ ok, code, reading?, reason? }`.
 */

/**
 * Process one telemetry envelope from a device.
 *
 * @param {object} opts
 * @param {object} opts.device   DeviceCredential (lean/doc) — provides deviceId, nodeId, maxCapacityKw
 * @param {object} opts.node     EnergyNode (lean) bound to the device
 * @param {object} opts.payload  raw telemetry envelope
 * @param {string} opts.transport 'mqtt' | 'http'
 * @param {string} [opts.ip]
 */
const processDeviceTelemetry = async ({ device, node, payload, transport, ip }) => {
  const deviceId = device?.deviceId || null;

  // 1. Shape / value / clock-skew validation.
  const validation = validateEnvelope(payload);
  if (!validation.ok) {
    await ingestionMetrics.recordRejection({
      kind: validation.code,
      source: transport,
      deviceId,
      nodeId: payload?.nodeId || null,
      messageId: payload?.messageId || null,
      reason: validation.message,
      payload,
      ip,
    });
    return { ok: false, code: validation.code, reason: validation.message };
  }

  const { nodeId, energyGenerated, energyConsumed, timestamp, messageId, unit } = validation.normalized;

  // 2. Device -> node binding (anti-impersonation). A device may only write to
  //    its bound node, even if the payload claims a different nodeId.
  if (device?.nodeId && String(device.nodeId) !== String(nodeId)) {
    await ingestionMetrics.recordRejection({
      kind: 'device_node_mismatch',
      source: transport,
      deviceId,
      nodeId,
      messageId,
      reason: 'payload nodeId does not match device bound nodeId',
      payload,
      ip,
    });
    return { ok: false, code: 'device_node_mismatch', reason: 'nodeId mismatch' };
  }

  // 3. Node active check (mirrors deviceAuth guard for HTTP; MQTT relies on
  //    broker + this re-check since status can change between connections).
  if (node && node.status !== 'active') {
    await ingestionMetrics.recordRejection({
      kind: 'unknown',
      source: transport,
      deviceId,
      nodeId,
      messageId,
      reason: `node status is ${node.status}`,
      payload,
      ip,
    });
    return { ok: false, code: 'NODE_INACTIVE', reason: 'bound node is not active' };
  }

  // 4. Capacity / out-of-range check against node + device caps.
  const cap = checkCapacity({ energyGenerated, energyConsumed, node, device });
  if (!cap.ok) {
    await ingestionMetrics.recordRejection({
      kind: 'out_of_range',
      source: transport,
      deviceId,
      nodeId,
      messageId,
      reason: cap.message,
      payload,
      ip,
    });
    return { ok: false, code: 'out_of_range', reason: cap.message };
  }

  // 5. Idempotency / dedup. messageId optional but strongly required for
  //    device paths — without it we cannot dedup, so we still accept but flag.
  const scopeId = deviceId || `node:${nodeId}`;
  if (messageId) {
    const { duplicate } = await checkAndMark({ scopeId, messageId });
    if (duplicate) {
      ingestionMetrics.recordDuplicate();
      return { ok: false, code: 'duplicate', reason: 'messageId already processed' };
    }
  }

  // 6. Ingest via the unified pipeline with source tagging.
  try {
    const reading = await readingService.ingestReading({
      source: 'device',
      nodeId,
      energyGenerated,
      energyConsumed,
      timestamp,
      meta: { deviceId, unit },
    });

    ingestionMetrics.recordAccepted({ source: 'device', transport, deviceId, ip });
    return { ok: true, reading };
  } catch (err) {
    await ingestionMetrics.recordRejection({
      kind: 'unknown',
      source: transport,
      deviceId,
      nodeId,
      messageId,
      reason: err.message,
      payload,
      ip,
    });
    return { ok: false, code: 'INGEST_ERROR', reason: err.message };
  }
};

/**
 * Resolve the bound node for a device. Kept separate so MQTT (which may not
 * have a freshly authenticated `node` on every message) can reuse it.
 */
const resolveDeviceNode = async (device) => {
  if (!device?.nodeId) return null;
  return EnergyNode.findById(device.nodeId).lean().exec();
};

module.exports = { processDeviceTelemetry, resolveDeviceNode };
