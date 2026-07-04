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
  // Module 9.5 — geographic coordinates for the live grid map. Optional so
  // legacy nodes keep working; GET /nodes/map only returns nodes that have
  // valid coordinates. Range is re-validated in nodeMapService before writes.
  coordinates: {
    lat: {
      type: Number,
      min: [-90, 'Latitude must be >= -90'],
      max: [90, 'Latitude must be <= 90'],
    },
    lng: {
      type: Number,
      min: [-180, 'Longitude must be >= -180'],
      max: [180, 'Longitude must be <= 180'],
    },
  },
  userId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
  },
  // Module 8.3 — grid segment this node belongs to. Optional so legacy nodes
  // keep working. A grid_operator whose assignedZoneIds includes this value
  // gains READ-ONLY visibility (never ownership). Lowercased on save so zone
  // matching is case-insensitive. Validated/sanitized in nodeOwnership helpers.
  zoneId: {
    type: String,
    default: null,
    trim: true,
    lowercase: true,
  },
  // Module 8.3 — delegated access. Each entry grants a non-owner read or write
  // access to THIS node without transferring ownership. Managed by the owner /
  // admin only (assertCanManageNodeAccess). Write delegates may mutate node
  // fields but can NEVER modify the operators list or zone (no escalation).
  operators: {
    type: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        permission: {
          type: String,
          enum: ['read', 'write'],
          required: true,
          default: 'read',
        },
        _id: false,
      },
    ],
    default: [],
  },
}, {
  timestamps: true,
});

energyNodeSchema.index({ userId: 1, createdAt: -1 });
energyNodeSchema.index({ status: 1 });
energyNodeSchema.index({ ingestionMode: 1 });
// Module 8.3 — fast zone-scoped reads for grid_operator visibility + delegate
// lookups (operators.userId).
energyNodeSchema.index({ zoneId: 1 });
energyNodeSchema.index({ 'operators.userId': 1 });

module.exports = mongoose.model('EnergyNode', energyNodeSchema);
