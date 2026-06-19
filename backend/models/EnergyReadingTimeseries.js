const mongoose = require('mongoose');

/**
 * Time-series readings collection (Sub-module 1.3.1).
 *
 * Operates on the `energyreadings_ts` MongoDB time-series collection created by
 * `services/timeseries/timeseriesSetup.js`. The schema mirrors the on-disk
 * document shape:
 *
 *   {
 *     timestamp,                       // timeField
 *     meta: { nodeId, source, ... },   // metaField — NO PII (guardrail 1.3)
 *     energyGenerated,
 *     energyConsumed,
 *     unit
 *   }
 *
 * `autoCreate` / `autoIndex` are disabled because time-series collections must
 * be created with explicit `timeseries` options via the raw driver; mongoose's
 * automatic collection creation would create a regular collection instead.
 * Indexes are managed in the setup service.
 *
 * This model is used purely for inserts and aggregations against the
 * already-created time-series collection.
 */

const VALID_SOURCES = ['simulated', 'device', 'admin', 'public_api', 'unknown'];

const tsSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true },
    meta: {
      nodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnergyNode' },
      // String form is also stored for convenience in aggregations.
      nodeIdStr: { type: String },
      source: { type: String, enum: VALID_SOURCES },
      providerKey: { type: String, default: null },
      deviceId: { type: String, default: null },
    },
    energyGenerated: { type: Number, default: 0 },
    energyConsumed: { type: Number, default: 0 },
    unit: { type: String, enum: ['kW', 'MW'], default: 'kW' },
  },
  {
    autoCreate: false,
    autoIndex: false,
    // Time-series documents are immutable; no updatedAt needed.
    timestamps: false,
    versionKey: false,
  },
);

tsSchema.statics.VALID_SOURCES = VALID_SOURCES;

module.exports = mongoose.model('EnergyReadingTimeseries', tsSchema, 'energyreadings_ts');
