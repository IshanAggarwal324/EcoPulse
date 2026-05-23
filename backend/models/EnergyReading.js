const mongoose = require('mongoose');

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
});

// Index to optimize querying readings by node and time
energyReadingSchema.index({ nodeId: 1, timestamp: -1 });

module.exports = mongoose.model('EnergyReading', energyReadingSchema);
