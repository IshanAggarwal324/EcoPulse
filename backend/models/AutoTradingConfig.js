const mongoose = require('mongoose');

/**
 * AutoTradingConfig (Sub-module 2.3 — admin runtime kill switch).
 *
 * A singleton (key='global') that holds the runtime enable/pause state for the
 * auto-listing matcher. This is a SECOND kill switch layered on top of the
 * `AUTO_TRADING_ENABLED` env flag: the env flag is the fail-closed deploy-time
 * gate, this doc is the redeploy-free admin pause. The matcher is active only
 * when BOTH are true:
 *
 *   isAutoTradingActive() === envEnabled && !config.paused
 *
 * Following the SimulatorConfig singleton pattern (getOrCreate + reset).
 */

const autoTradingConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'global',
    },
    paused: {
      type: Boolean,
      default: true, // fail-closed until an admin explicitly resumes
    },
    pausedAt: {
      type: Date,
      default: null,
    },
    pausedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    pausedReason: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
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

autoTradingConfigSchema.index({ key: 1 }, { unique: true });

const getDefaults = () => ({
  key: 'global',
  paused: true,
});

// Singleton accessor — creates the paused-by-default doc on first touch.
autoTradingConfigSchema.statics.getOrCreate = async function getOrCreate() {
  const existing = await this.findOne({ key: 'global' });
  if (existing) return existing;
  return this.create(getDefaults());
};

module.exports = mongoose.model('AutoTradingConfig', autoTradingConfigSchema);
