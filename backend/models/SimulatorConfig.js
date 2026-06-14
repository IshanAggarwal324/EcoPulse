const mongoose = require('mongoose');
const { CAPACITY_KW } = require('../services/simulator/profiles');

const SOURCE_TYPES = ['solar', 'wind', 'home', 'industry', 'other'];
const FAILURE_MODES = ['offline', 'reduced_output', 'spike', 'intermittent'];
const FAILURE_TARGETS = ['node', 'source'];

const profileSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      enum: SOURCE_TYPES,
      required: true,
    },
    capacityGenerateKw: {
      type: Number,
      min: 0,
      default: 0,
    },
    capacityConsumeKw: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  { _id: false },
);

const failureModeSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      trim: true,
      default: '',
    },
    target: {
      type: String,
      enum: FAILURE_TARGETS,
      default: 'node',
    },
    // Used when target === 'node'
    nodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EnergyNode',
      default: null,
    },
    // Used when target === 'source' (applies to every node of this sourceType)
    sourceType: {
      type: String,
      enum: SOURCE_TYPES,
      default: null,
    },
    mode: {
      type: String,
      enum: FAILURE_MODES,
      required: true,
    },
    // 0..1 chance per tick that the failure activates
    probability: {
      type: Number,
      min: 0,
      max: 1,
      default: 0,
    },
    // How many ticks the failure persists once activated
    durationTicks: {
      type: Number,
      min: 1,
      default: 1,
    },
    // Multiplier applied to generation (e.g. 0.3 reduced, 2.5 spike)
    outputMultiplier: {
      type: Number,
      min: 0,
      default: 0,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  { _id: true },
);

const simulatorConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'global',
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    intervalMs: {
      type: Number,
      min: 1000,
      default: 5000,
    },
    jitterMs: {
      type: Number,
      min: 0,
      default: 1500,
    },
    profiles: {
      type: [profileSchema],
      default: () => [],
    },
    failureModes: {
      type: [failureModeSchema],
      default: () => [],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

simulatorConfigSchema.index({ key: 1 }, { unique: true });

const DEFAULT_PROFILES = Object.entries(CAPACITY_KW).map(([sourceType, cap]) => ({
  sourceType,
  capacityGenerateKw: cap.generate,
  capacityConsumeKw: cap.consume,
}));

const getDefaults = () => ({
  key: 'global',
  enabled: true,
  intervalMs: parseInt(process.env.SIM_INTERVAL_MS || '5000', 10),
  jitterMs: parseInt(process.env.SIM_INTERVAL_JITTER_MS || '1500', 10),
  profiles: DEFAULT_PROFILES.map((p) => ({ ...p })),
  failureModes: [],
});

// Singleton accessor — creates the doc seeded from profiles.js on first touch.
simulatorConfigSchema.statics.getOrCreate = async function getOrCreate() {
  const existing = await this.findOne({ key: 'global' });
  if (existing) return existing;

  const seed = getDefaults();
  return this.create(seed);
};

simulatorConfigSchema.statics.resetToDefaults = async function resetToDefaults(updatedBy = null) {
  const seed = getDefaults();
  seed.updatedBy = updatedBy;
  return this.findOneAndUpdate({ key: 'global' }, { $set: seed }, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });
};

const SimulatorConfig = mongoose.model('SimulatorConfig', simulatorConfigSchema);

module.exports = SimulatorConfig;
module.exports.DEFAULT_PROFILES = DEFAULT_PROFILES;
module.exports.SOURCE_TYPES = SOURCE_TYPES;
module.exports.FAILURE_MODES = FAILURE_MODES;
module.exports.FAILURE_TARGETS = FAILURE_TARGETS;
