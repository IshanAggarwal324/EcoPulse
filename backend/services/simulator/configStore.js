const mongoose = require('mongoose');
const { CAPACITY_KW } = require('./profiles');

// In-memory cache of the active SimulatorConfig. Falls back to hardcoded
// defaults derived from profiles.js so the standalone CLI simulator keeps
// working without a database connection.
let cache = null;
let loadPromise = null;

const buildDefaults = () => ({
  key: 'global',
  enabled: true,
  intervalMs: parseInt(process.env.SIM_INTERVAL_MS || '5000', 10),
  jitterMs: parseInt(process.env.SIM_INTERVAL_JITTER_MS || '1500', 10),
  profiles: Object.entries(CAPACITY_KW).map(([sourceType, cap]) => ({
    sourceType,
    capacityGenerateKw: cap.generate,
    capacityConsumeKw: cap.consume,
  })),
  failureModes: [],
});

// Normalised capacity-override map keyed by sourceType for fast lookup.
const overridesFromConfig = (config) => {
  const overrides = {};
  for (const p of config?.profiles || []) {
    if (p.sourceType) {
      overrides[p.sourceType] = {
        capacityGenerateKw: p.capacityGenerateKw,
        capacityConsumeKw: p.capacityConsumeKw,
      };
    }
  }
  return overrides;
};

const load = async () => {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (mongoose.connection.readyState !== 1) {
      cache = buildDefaults();
      return cache;
    }
    try {
      // Lazy require to avoid loading the model before mongoose connects.
      const SimulatorConfig = require('../../models/SimulatorConfig');
      const doc = await SimulatorConfig.getOrCreate();
      cache = doc.toObject();
      return cache;
    } catch (err) {
      console.warn('[Simulator] config load failed, using defaults:', err.message);
      cache = buildDefaults();
      return cache;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
};

// Re-read the config from the database (admin-triggered). Safe to call before
// initial load; it will perform a load.
const reload = async () => {
  loadPromise = null;
  return load();
};

const get = () => cache || buildDefaults();

const isEnabled = () => {
  const config = get();
  return config?.enabled !== false;
};

const getCapacityOverrides = () => overridesFromConfig(get());

const getIntervalMs = () => get()?.intervalMs ?? buildDefaults().intervalMs;
const getJitterMs = () => get()?.jitterMs ?? buildDefaults().jitterMs;

module.exports = {
  load,
  reload,
  get,
  isEnabled,
  getCapacityOverrides,
  getIntervalMs,
  getJitterMs,
  buildDefaults,
};
