const mongoose = require('mongoose');

/**
 * Hourly rollup collection (Sub-module 1.3.6).
 *
 * Materialized from the `energyreadings_ts` time-series collection by the
 * rollup worker. One document per (nodeId, hour) bucket — supports fast
 * dashboard + assistant retrieval after raw readings expire at the 90-day TTL.
 *
 * The compound unique index `{ nodeId: 1, hour: 1 }` (created in setup) makes
 * the rollup job idempotent: re-running a bucket upserts the same key.
 */
const energyReadingHourlySchema = new mongoose.Schema(
  {
    nodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EnergyNode',
      required: true,
    },
    hour: {
      // UTC hour bucket (Date truncated to the top of the hour).
      type: Date,
      required: true,
    },
    energyGenerated: { type: Number, default: 0 },
    energyConsumed: { type: Number, default: 0 },
    readingCount: { type: Number, default: 0 },
    peakGenerated: { type: Number, default: 0 },
    peakConsumed: { type: Number, default: 0 },
    unit: { type: String, enum: ['kW', 'MW'], default: 'kW' },
    lastUpdated: { type: Date, default: Date.now },
  },
  { autoIndex: false, versionKey: false },
);

energyReadingHourlySchema.index({ nodeId: 1, hour: -1 });

module.exports = mongoose.model('EnergyReadingHourly', energyReadingHourlySchema, 'energyreadings_hourly');
