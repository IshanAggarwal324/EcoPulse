const mongoose = require('mongoose');

/**
 * Persisted meter anomaly events (Module 4.1).
 *
 * Written by anomalyController after the AI service flags readings. Persisted
 * in the backend (not the AI service) so each event is tied to the
 * authenticated, ownership-checked user. Deduplicated per
 * {userId, nodeId, timestamp, reasonCode} so repeated scoring doesn't inflate
 * the audit trail. TTL-retained for bounded storage.
 */
const anomalyEventSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    nodeId: {
      type: mongoose.Schema.ObjectId,
      ref: 'EnergyNode',
      required: true,
    },
    timestamp: {
      type: Date,
      required: true,
    },
    reasonCode: {
      type: String,
      required: true,
      default: 'ml_anomaly',
    },
    reasonCodes: {
      type: [String],
      default: [],
    },
    score: {
      type: Number,
      min: 0,
      max: 1,
      default: null,
    },
    generation: { type: Number, default: null },
    consumption: { type: Number, default: null },
    dismissedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

anomalyEventSchema.index({ userId: 1, nodeId: 1, timestamp: -1 });
anomalyEventSchema.index({ userId: 1, timestamp: -1 });
// Dedupe: one event per (user, node, reading-time, reason). A unique compound
// index makes upsert-based persistence idempotent across repeated scoring runs.
anomalyEventSchema.index(
  { userId: 1, nodeId: 1, timestamp: 1, reasonCode: 1 },
  { unique: true },
);

// Bounded retention. Default 1 year; override via env.
const ttlDays = Math.max(7, parseInt(process.env.ANOMALY_EVENT_TTL_DAYS || '365', 10));
if (Number.isFinite(ttlDays)) {
  anomalyEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays * 86400 });
}

module.exports = mongoose.model('AnomalyEvent', anomalyEventSchema);
