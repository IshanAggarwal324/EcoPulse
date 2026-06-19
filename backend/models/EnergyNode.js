const mongoose = require('mongoose');

const energyNodeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a node name'],
    trim: true,
  },
  nodeType: {
    type: String,
    enum: ['producer', 'consumer', 'prosumer'],
    required: [true, 'Please add a node type'],
  },
  sourceType: {
    type: String,
    enum: ['solar', 'wind', 'home', 'industry', 'other'],
    required: [true, 'Please add a source type'],
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'maintenance', 'failed'],
    default: 'active',
  },
  // Sub-module 1.1.4 — declares which ingestion source feeds this node.
  // `simulated` is the historical default so existing nodes (and the embedded
  // simulator) keep working unchanged. `public_api` nodes are admin-seeded grid
  // zones that never receive a DeviceCredential.
  ingestionMode: {
    type: String,
    enum: ['simulated', 'device', 'public_api', 'hybrid'],
    default: 'simulated',
  },
  // Optional hard cap used by the unified ingestion pipeline to reject
  // implausible telemetry (kW or MW depending on node scale). Null = uncapped.
  maxCapacityKw: {
    type: Number,
    min: 0,
    default: null,
  },
  location: {
    type: String,
  },
  userId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('EnergyNode', energyNodeSchema);
