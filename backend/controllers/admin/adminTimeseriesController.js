const asyncHandler = require('../../utils/asyncHandler');
const timeseriesSetup = require('../../services/timeseries/timeseriesSetup');
const rollupWorker = require('../../workers/rollupWorker');
const {
  isTimeseriesEnabled,
  isDualWriteEnabled,
  COLLECTION_TS,
  COLLECTION_HOURLY,
  COLLECTION_LEGACY,
} = require('../../config/timeseries');
const EnergyReading = require('../../models/EnergyReading');
const EnergyReadingTimeseries = require('../../models/EnergyReadingTimeseries');

/**
 * Admin time-series status + controls (Sub-module 1.3).
 *
 * GET  /admin/ingestion/timeseries/status   — flags, collection stats, counts
 * POST /admin/ingestion/timeseries/rollup    — manually trigger a rollup
 *                                              (single hour or a window)
 */

const getStatus = asyncHandler(async (req, res) => {
  const [setupDescribe, legacyCount, tsCount] = await Promise.all([
    timeseriesSetup.describe().catch(() => null),
    EnergyReadcountSafe(),
    EnergyReadingTimeseries.countDocuments({}).catch(() => null),
  ]);

  res.status(200).json({
    success: true,
    data: {
      enabled: isTimeseriesEnabled(),
      dualWrite: isDualWriteEnabled(),
      collections: { legacy: COLLECTION_LEGACY, timeseries: COLLECTION_TS, rollup: COLLECTION_HOURLY },
      legacyCount,
      timeseriesCount: tsCount,
      setup: setupDescribe,
      rollup: rollupWorker.getStatus(),
    },
  });
});

const EnergyReadcountSafe = async () => {
  try {
    return await EnergyReading.countDocuments({});
  } catch {
    return null;
  }
};

const triggerRollup = asyncHandler(async (req, res) => {
  const { hour, from, to } = req.body || {};

  let result;
  if (from) {
    result = await rollupWorker.rollupWindow(new Date(from), to ? new Date(to) : new Date());
  } else {
    result = await rollupWorker.rollupHour(hour ? new Date(hour) : undefined);
  }

  res.status(200).json({
    success: true,
    data: result,
  });
});

module.exports = { getStatus, triggerRollup };
