const mongoose = require('mongoose');

const VALID_SOURCES = ['simulated', 'device', 'admin', 'public_api'];

const energyReadingSchema = new mongoose.Schema({
  nodeId: {
    type: mongoose.Schema.ObjectId,
    ref: 'EnergyNode',
    required: true,
  },
  energyGenerated: {
    type: Number,
    default: 0,
  },
  energyConsumed: {
    type: Number,
    default: 0,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  // Sub-module 1.2.6 — source tagging. All fields optional/default-absent so
  // existing queries and the dashboard continue to work unchanged. Legacy rows
  // implicitly read as `source: undefined`; backfill (1.3.3) will set them.
  source: {
    type: String,
    enum: VALID_SOURCES,
    default: null,
    index: true,
  },
  deviceId: {
    // Set when source === 'device' (DeviceCredential.deviceId, not the Mongo _id).
    type: String,
    default: null,
  },
  providerKey: {
    // e.g. 'smard_de' when source === 'public_api'.
    type: String,
    default: null,
  },
  externalReadingId: {
    // Provider-native id used for public_api dedup.
    type: String,
    default: null,
  },
  unit: {
    // 'kW' (home IoT / simulator) or 'MW' (national grid zones). UI label hint.
    type: String,
    enum: ['kW', 'MW'],
    default: 'kW',
  },
});

// Index to optimize querying readings by node and time
energyReadingSchema.index({ nodeId: 1, timestamp: -1 });
// Dedup / source-filtered lookups (public_api externalReadingId uniqueness).
energyReadingSchema.index({ providerKey: 1, externalReadingId: 1 }, { sparse: true });

energyReadingSchema.statics.VALID_SOURCES = VALID_SOURCES;

module.exports = mongoose.model('EnergyReading', energyReadingSchema);
