const mongoose = require('mongoose');

/**
 * Telemetry payload schema validation (Sub-module 1.2.2).
 *
 * Validates the device telemetry envelope:
 *   { nodeId, energyGenerated, energyConsumed, timestamp?, messageId?, unit }
 *
 * Enforces:
 *  - required fields and correct types
 *  - non-negative, finite numeric values
 *  - out-of-range rejection against the bound node's maxCapacityKw (or the
 *    device's per-device cap), if either is configured
 *  - timestamp clock-skew rejection (±INGESTION_CLOCK_SKEW_MS, default 5 min)
 *    unless ALLOW_CLOCK_SKEW=true
 *
 * Returns `{ ok: true, normalized }` on success or
 * `{ ok: false, code, message }` on failure. Never throws — callers route
 * failures to the dead-letter queue / metrics.
 */

const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const getClockSkewMs = () => {
  if (String(process.env.ALLOW_CLOCK_SKEW || '').toLowerCase() === 'true') {
    return null; // disabled
  }
  const parsed = parseInt(process.env.INGESTION_CLOCK_SKEW_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLOCK_SKEW_MS;
};

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Validate raw envelope shape. Does NOT touch Mongo.
 */
const validateEnvelope = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'INVALID_JSON', message: 'Telemetry payload must be a JSON object' };
  }

  const { nodeId, energyGenerated, energyConsumed, timestamp, messageId, unit } = payload;

  if (!nodeId || typeof nodeId !== 'string' || !mongoose.Types.ObjectId.isValid(nodeId)) {
    return { ok: false, code: 'INVALID_NODE_ID', message: 'nodeId must be a valid identifier' };
  }

  if (energyGenerated === undefined || !isFiniteNumber(energyGenerated)) {
    return { ok: false, code: 'INVALID_GENERATED', message: 'energyGenerated must be a finite number' };
  }
  if (energyConsumed === undefined || !isFiniteNumber(energyConsumed)) {
    return { ok: false, code: 'INVALID_CONSUMED', message: 'energyConsumed must be a finite number' };
  }

  if (energyGenerated < 0 || energyConsumed < 0) {
    return { ok: false, code: 'NEGATIVE_VALUE', message: 'energy values must be non-negative' };
  }

  // Sanity ceiling to reject obvious sensor garbage / overflow even before the
  // node-capacity check (kW or MW). 1e9 ≈ national-grid-scale absurd value.
  const ABS_CEILING = 1e9;
  if (energyGenerated > ABS_CEILING || energyConsumed > ABS_CEILING) {
    return { ok: false, code: 'OUT_OF_RANGE', message: 'energy value exceeds absolute ceiling' };
  }

  if (messageId !== undefined && messageId !== null) {
    if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 128) {
      return { ok: false, code: 'INVALID_MESSAGE_ID', message: 'messageId must be a 1-128 char string' };
    }
  }

  if (unit !== undefined && unit !== null && unit !== 'kW' && unit !== 'MW') {
    return { ok: false, code: 'INVALID_UNIT', message: 'unit must be "kW" or "MW"' };
  }

  // Timestamp skew check.
  const skewMs = getClockSkewMs();
  let resolvedTimestamp = null;
  if (timestamp !== undefined && timestamp !== null) {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return { ok: false, code: 'INVALID_TIMESTAMP', message: 'timestamp must be ISO-8601 parseable' };
    }
    if (skewMs !== null) {
      const diff = Math.abs(Date.now() - date.getTime());
      if (diff > skewMs) {
        return {
          ok: false,
          code: 'CLOCK_SKEW',
          message: `timestamp is outside the allowed ±${skewMs}ms skew window`,
        };
      }
    }
    resolvedTimestamp = date;
  }

  return {
    ok: true,
    normalized: {
      nodeId,
      energyGenerated,
      energyConsumed,
      timestamp: resolvedTimestamp,
      messageId: typeof messageId === 'string' ? messageId : null,
      unit: unit === 'MW' ? 'MW' : 'kW',
    },
  };
};

/**
 * Capacity check against the bound node + device caps (1.2.2 out-of-range).
 * Pass the already-loaded node and (optional) device record to avoid extra
 * Mongo round-trips.
 */
const checkCapacity = ({ energyGenerated, energyConsumed, node, device }) => {
  const caps = [];
  if (typeof node?.maxCapacityKw === 'number' && node.maxCapacityKw > 0) {
    caps.push({ label: 'node', value: node.maxCapacityKw });
  }
  if (typeof device?.maxCapacityKw === 'number' && device.maxCapacityKw > 0) {
    caps.push({ label: 'device', value: device.maxCapacityKw });
  }

  if (caps.length === 0) return { ok: true };

  // Use the most restrictive cap.
  const cap = caps.reduce((min, c) => (c.value < min.value ? c : min));
  const peak = Math.max(energyGenerated, energyConsumed);
  // Allow a small (10%) tolerance to absorb sensor noise at the boundary.
  const ceiling = cap.value * 1.1;
  if (peak > ceiling) {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      message: `value ${peak} exceeds ${cap.label} capacity ${cap.value} (kW)`,
    };
  }
  return { ok: true };
};

module.exports = {
  validateEnvelope,
  checkCapacity,
  DEFAULT_CLOCK_SKEW_MS,
};
