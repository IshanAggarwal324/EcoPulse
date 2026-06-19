const EnergyReadingTimeseries = require('../../models/EnergyReadingTimeseries');
const EnergyReadingHourly = require('../../models/EnergyReadingHourly');
const {
  ANALYTICS_READ_PREFERENCE,
  FORECAST_LOOKBACK_DAYS,
} = require('../../config/timeseries');

/**
 * Time-series optimized analytics (Sub-module 1.3.4).
 *
 * Replaces the legacy `energyAnalytics.js` full-collection `$sum` scans with
 * `$bucket` / `$dateTrunc` aggregations that push bucketing to the server and
 * read from secondaries. Used by the summary/analytics services when
 * TIMESERIES_ENABLED=true; legacy functions remain the fallback otherwise.
 *
 * Read preference: secondaryPreferred offloads the primary write path
 * (guardrail 1.3: "Read replicas for analytics queries; write path stays on
 * primary").
 */

const READ = ANALYTICS_READ_PREFERENCE;

const getTimeseriesEnergyTotals = async (since) => {
  const match = since ? { timestamp: { $gte: since } } : {};

  const [result] = await EnergyReadingTimeseries.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalGenerated: { $sum: '$energyGenerated' },
        totalConsumed: { $sum: '$energyConsumed' },
        readingCount: { $sum: 1 },
      },
    },
  ]).read(READ);

  return {
    totalGenerated: result?.totalGenerated || 0,
    totalConsumed: result?.totalConsumed || 0,
    readingCount: result?.readingCount || 0,
  };
};

/**
 * Per-source breakdown — surfaces the simulated vs device vs public_api mix.
 */
const getTimeseriesBySource = async (since) => {
  const match = since ? { timestamp: { $gte: since } } : {};

  const rows = await EnergyReadingTimeseries.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$meta.source',
        totalGenerated: { $sum: '$energyGenerated' },
        totalConsumed: { $sum: '$energyConsumed' },
        readingCount: { $sum: 1 },
      },
    },
  ]).read(READ);

  return rows.reduce((acc, row) => {
    acc[row._id || 'unknown'] = {
      totalGenerated: row.totalGenerated,
      totalConsumed: row.totalConsumed,
      readingCount: row.readingCount,
    };
    return acc;
  }, {});
};

/**
 * Daily/hourly bucketed series using $bucket. Returns sorted time series for the
 * dashboard charts without pulling raw documents into the app.
 */
const getTimeseriesBucketed = async ({ since, until, granularity = 'hour', nodeId }) => {
  const boundaries = granularity === 'day' ? oneDayBoundaries(since, until) : oneHourBoundaries(since, until);

  const match = {};
  if (since || until) {
    match.timestamp = {};
    if (since) match.timestamp.$gte = since;
    if (until) match.timestamp.$lt = until;
  }
  if (nodeId) match['meta.nodeId'] = castObjectId(nodeId);

  const pipeline = [
    { $match: match },
    {
      $bucket: {
        groupBy: '$timestamp',
        boundaries,
        default: 'other',
        output: {
          generated: { $sum: '$energyGenerated' },
          consumed: { $sum: '$energyConsumed' },
          count: { $sum: 1 },
        },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const rows = await EnergyReadingTimeseries.aggregate(pipeline).read(READ);
  return rows
    .filter((r) => r._id !== 'other')
    .map((r) => ({
      bucket: r._id,
      generated: r.generated,
      consumed: r.consumed,
      count: r.count,
    }));
};

/**
 * Fast per-node recent readings read from the rollup collection (survives the
 * raw TTL). Returns the most recent N hourly buckets.
 */
const getRecentHourlyRollups = async (nodeId, { limit = 24 } = {}) => {
  if (!nodeId) return [];
  return EnergyReadingHourly.find({ nodeId: castObjectId(nodeId) })
    .sort({ hour: -1 })
    .limit(limit)
    .read(READ)
    .lean();
};

/**
 * Downsampled lookback for the AI/forecast path (1.3.5 helper, used from the
 * AI service via the API surface). Returns daily aggregates for the configured
 * FORECAST_LOOKBACK_DAYS window.
 */
const getForecastLookback = async (nodeId) => {
  const since = new Date(Date.now() - FORECAST_LOOKBACK_DAYS * 86400 * 1000);
  const match = { timestamp: { $gte: since } };
  if (nodeId) match['meta.nodeId'] = castObjectId(nodeId);

  const rows = await EnergyReadingTimeseries.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $dateTrunc: { date: '$timestamp', unit: 'day', timezone: 'UTC' },
        },
        generation: { $sum: '$energyGenerated' },
        consumption: { $sum: '$energyConsumed' },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]).read(READ);

  return rows.map((r) => ({
    timestamp: r._id,
    generation: r.generation,
    consumption: r.consumption,
    count: r.count,
  }));
};

/* ── helpers ──────────────────────────────────────────────────────────── */

const castObjectId = (nodeId) => {
  try {
    return new (require('mongoose').Types.ObjectId)(nodeId);
  } catch {
    return nodeId;
  }
};

const oneHourBoundaries = (since, until) => {
  const start = new Date((since || new Date(Date.now() - 24 * 3600 * 1000)).getTime());
  start.setUTCMinutes(0, 0, 0);
  const end = until || new Date();
  const bounds = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    bounds.push(new Date(cursor));
    cursor.setUTCHours(cursor.getUTCHours() + 1);
    if (bounds.length > 720) break; // safety cap (~30 days hourly)
  }
  bounds.push(new Date(cursor));
  return bounds;
};

const oneDayBoundaries = (since, until) => {
  const start = new Date((since || new Date(Date.now() - 30 * 86400 * 1000)).getTime());
  start.setUTCHours(0, 0, 0, 0);
  const end = until || new Date();
  const bounds = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    bounds.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (bounds.length > 366) break;
  }
  bounds.push(new Date(cursor));
  return bounds;
};

module.exports = {
  getTimeseriesEnergyTotals,
  getTimeseriesBySource,
  getTimeseriesBucketed,
  getRecentHourlyRollups,
  getForecastLookback,
};
