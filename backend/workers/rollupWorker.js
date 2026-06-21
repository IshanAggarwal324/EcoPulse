const EnergyReadingTimeseries = require('../models/EnergyReadingTimeseries');
const EnergyReadingHourly = require('../models/EnergyReadingHourly');
const { isTimeseriesEnabled, ROLLUP_INTERVAL_MS } = require('../config/timeseries');

/**
 * Hourly rollup worker (Sub-module 1.3.6).
 *
 * Periodically materializes hourly buckets from the `energyreadings_ts`
 * time-series collection into `energyreadings_hourly`. Idempotent: each bucket
 * is upserted on the `{ nodeId, hour }` unique key, so re-runs (or a manual
 * trigger) simply recompute the same bucket.
 *
 * Read preference: aggregation reads from secondaries (configured at the
 * collection operation level) so the heavy rollup scan does not contend with
 * the primary write path (guardrail 1.3).
 */

let timer = null;
let bootstrapTimer = null;
let lastRunAt = null;
let lastRunSummary = null;
let running = false;

const READ_PREF = 'secondaryPreferred';

const truncateToHour = (date) => {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
};

/**
 * Roll up the hour containing `bucketHour` for all nodes. Returns a summary.
 *
 * @param {Date} bucketHour  an hour-truncated Date (defaults to previous hour)
 */
const rollupHour = async (bucketHourInput) => {
  if (!isTimeseriesEnabled()) {
    return { ok: false, reason: 'timeseries disabled' };
  }

  const bucketHour = truncateToHour(bucketHourInput || new Date(Date.now() - 3600 * 1000));
  const start = bucketHour;
  const end = new Date(bucketHour.getTime() + 3600 * 1000);

  // Server-side aggregation with $dateTrunc keeps the scan off the app process.
  // Reads via secondaryPreferred to protect the primary write path.
  const pipeline = [
    { $match: { timestamp: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: '$meta.nodeId',
        energyGenerated: { $sum: '$energyGenerated' },
        energyConsumed: { $sum: '$energyConsumed' },
        readingCount: { $sum: 1 },
        peakGenerated: { $max: '$energyGenerated' },
        peakConsumed: { $max: '$energyConsumed' },
      },
    },
  ];

  const buckets = await EnergyReadingTimeseries.aggregate(pipeline).read(READ_PREF);

  if (buckets.length === 0) {
    return { ok: true, bucketHour: bucketHour.toISOString(), upserted: 0 };
  }

  const ops = buckets.map((b) => ({
    updateOne: {
      filter: { nodeId: b._id, hour: bucketHour },
      update: {
        $set: {
          nodeId: b._id,
          hour: bucketHour,
          energyGenerated: b.energyGenerated,
          energyConsumed: b.energyConsumed,
          readingCount: b.readingCount,
          peakGenerated: b.peakGenerated,
          peakConsumed: b.peakConsumed,
          unit: 'kW',
          lastUpdated: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await EnergyReadingHourly.bulkWrite(ops, { ordered: false });

  return {
    ok: true,
    bucketHour: bucketHour.toISOString(),
    upserted: buckets.length,
  };
};

/**
 * Backfill rollups for an arbitrary window — used after migration or to
 * recover from a worker outage. Iterates hour by hour.
 */
const rollupWindow = async (fromDate, toDate) => {
  if (!isTimeseriesEnabled()) return { ok: false, reason: 'timeseries disabled' };

  const from = truncateToHour(fromDate);
  const to = truncateToHour(toDate || new Date());
  const summaries = [];
  let cursor = new Date(from);

  while (cursor < to) {
    // eslint-disable-next-line no-await-in-loop
    const summary = await rollupHour(cursor);
    summaries.push(summary);
    cursor = new Date(cursor.getTime() + 3600 * 1000);
  }

  return {
    ok: true,
    from: from.toISOString(),
    to: to.toISOString(),
    hoursProcessed: summaries.length,
    bucketsUpserted: summaries.reduce((acc, s) => acc + (s.upserted || 0), 0),
  };
};

const tick = async () => {
  if (running) return;
  running = true;
  try {
    const summary = await rollupHour();
    lastRunAt = new Date();
    lastRunSummary = summary;
  } catch (err) {
    console.error('[rollupWorker] tick failed:', err.message);
    lastRunSummary = { ok: false, error: err.message };
  } finally {
    running = false;
  }
};

const start = () => {
  if (!isTimeseriesEnabled() || timer) return false;
  // Stagger the first run 2 min after boot so the setup service finishes first.
  bootstrapTimer = setTimeout(tick, 2 * 60 * 1000);
  timer = setInterval(tick, ROLLUP_INTERVAL_MS);
  console.log(`[rollupWorker] started (every ${ROLLUP_INTERVAL_MS}ms)`);
  return true;
};

const stop = () => {
  if (bootstrapTimer) {
    clearTimeout(bootstrapTimer);
    bootstrapTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

const getStatus = () => ({
  enabled: isTimeseriesEnabled(),
  running: !!timer,
  busy: running,
  intervalMs: ROLLUP_INTERVAL_MS,
  lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
  lastRunSummary,
});

module.exports = { start, stop, tick, rollupHour, rollupWindow, getStatus };
