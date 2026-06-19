const mongoose = require('mongoose');

/**
 * IngestionError — dead-letter queue (guardrail 1.2).
 *
 * Persisted record of a telemetry message that was rejected (malformed,
 * out-of-range, clock-skewed, duplicate, capacity-exceeding, device-mismatch).
 * Chosen over a Redis list because Mongo is queryable by the admin ingestion
 * dashboard and survives restarts; a TTL index caps storage cost.
 */
const VALID_KINDS = [
  'invalid_json',
  'invalid_node_id',
  'invalid_generated',
  'invalid_consumed',
  'negative_value',
  'invalid_message_id',
  'invalid_unit',
  'invalid_timestamp',
  'clock_skew',
  'out_of_range',
  'duplicate',
  'device_node_mismatch',
  'unknown',
];

const ingestionErrorSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: VALID_KINDS,
      required: true,
      index: true,
    },
    source: {
      // Origin path: mqtt | http | poller. (Different from reading `source`.)
      type: String,
      enum: ['mqtt', 'http', 'poller'],
      required: true,
      index: true,
    },
    deviceId: { type: String, default: null, index: true },
    nodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnergyNode', default: null },
    providerKey: { type: String, default: null },
    messageId: { type: String, default: null },
    reason: { type: String, default: null },
    // The raw payload is stored for forensics but capped in size and sanitized
    // by the caller before insert (no secrets/PII expected in telemetry).
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

ingestionErrorSchema.index({ createdAt: -1 });
ingestionErrorSchema.index({ source: 1, createdAt: -1 });

const ttlDays = parseInt(process.env.INGESTION_ERROR_TTL_DAYS || '14', 10);
if (Number.isFinite(ttlDays) && ttlDays > 0) {
  ingestionErrorSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays * 86400 });
}

ingestionErrorSchema.statics.VALID_KINDS = VALID_KINDS;

module.exports = mongoose.model('IngestionError', ingestionErrorSchema);
