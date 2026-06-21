const EnergyReading = require('../../models/EnergyReading');
const { isTimeseriesEnabled } = require('../../config/timeseries');
const {
  getTimeseriesEnergyTotals,
  getTimeseriesBySource,
} = require('./timeseriesAnalytics');

const LEGACY_TOTALS_TTL_MS = parseInt(process.env.ENERGY_TOTALS_CACHE_MS || '30000', 10);
let legacyTotalsCache = { at: 0, sinceKey: null, value: null };

/**
 * Energy analytics (Sub-module 1.3.4 — flag-aware dispatcher).
 *
 * When TIMESERIES_ENABLED=true, totals route to the optimized time-series
 * aggregation (server-side $sum, secondary read preference). Otherwise the
 * original legacy `energyreadings` scan runs unchanged — preserving the
 * pre-1.3 path and behavior exactly.
 */

const getEnergyTotals = async (since) => {
  if (isTimeseriesEnabled()) {
    return getTimeseriesEnergyTotals(since);
  }

  const sinceKey = since ? since.toISOString() : 'all';
  if (
    legacyTotalsCache.sinceKey === sinceKey
    && Date.now() - legacyTotalsCache.at < LEGACY_TOTALS_TTL_MS
  ) {
    return legacyTotalsCache.value;
  }

  const match = since ? { timestamp: { $gte: since } } : {};

  const [resultRow] = await EnergyReading.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalGenerated: { $sum: '$energyGenerated' },
        totalConsumed: { $sum: '$energyConsumed' },
        readingCount: { $sum: 1 },
      },
    },
  ]);

  const totals = {
    totalGenerated: resultRow?.totalGenerated || 0,
    totalConsumed: resultRow?.totalConsumed || 0,
    readingCount: resultRow?.readingCount || 0,
  };

  legacyTotalsCache = { at: Date.now(), sinceKey, value: totals };
  return totals;
};

/**
 * Per-source breakdown. Only populated on the time-series path (legacy
 * collection rows may lack `source`). Returns {} when disabled.
 */
const getEnergyBySource = async (since) => {
  if (!isTimeseriesEnabled()) return {};
  return getTimeseriesBySource(since);
};

const getRecentReadings = async (limit = 20) => EnergyReading.find()
  .sort({ timestamp: -1 })
  .limit(limit)
  .populate('nodeId', 'name nodeType sourceType status')
  .lean();

module.exports = { getEnergyTotals, getEnergyBySource, getRecentReadings };
