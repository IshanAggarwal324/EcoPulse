/**
 * Time-series storage configuration (Sub-module 1.3).
 *
 * Centralizes every env-driven knob for the MongoDB time-series migration so
 * all modules (writer, analytics, rollup worker, setup, AI service) read from
 * one source of truth. Defaults preserve the pre-1.3 behavior: time-series is
 * OFF, the legacy `energyreadings` collection remains the source of truth.
 */

const isTimeseriesEnabled = () =>
  String(process.env.TIMESERIES_ENABLED || '').toLowerCase() === 'true';

// Dual-write means new readings land in BOTH the legacy `energyreadings`
// collection and the `energyreadings_ts` time-series collection. This is the
// safe transition state (1.3 → 1.4 cutover). When false + enabled, writes go
// ONLY to the time-series collection (post-cutover).
const isDualWriteEnabled = () =>
  String(process.env.TIMESERIES_DUAL_WRITE || 'true').toLowerCase() === 'true';

// Whether the app should refuse writes while a migration is in flight
// (guardrail 1.3: "Migration runs with read-only app mode flag").
const isReadOnlyMode = () =>
  String(process.env.APP_READ_ONLY_MODE || '').toLowerCase() === 'true';

const COLLECTION_TS = process.env.TIMESERIES_COLLECTION || 'energyreadings_ts';
const COLLECTION_HOURLY = process.env.ROLLUP_HOURLY_COLLECTION || 'energyreadings_hourly';
const COLLECTION_LEGACY = 'energyreadings';

// Time-series granularity. MongoDB accepts 'seconds' | 'minutes' | 'hours'.
// Telemetry arrives sub-minute → 'seconds' would over-segment; 'minutes' is the
// right tradeoff for dashboard + forecasting granularity.
const GRANULARITY = process.env.TIMESERIES_GRANULARITY || 'minutes';

// TTL on the RAW time-series collection (caps storage cost). Rollups (hourly)
// are retained longer so historical analytics still work after raw expiry.
const RAW_TTL_DAYS = parseInt(process.env.TIMESERIES_RAW_TTL_DAYS || '90', 10);
const ROLLUP_TTL_DAYS = parseInt(process.env.ROLLUP_HOURLY_TTL_DAYS || '730', 10);

// AI / forecasting lookback window.
const FORECAST_LOOKBACK_DAYS = parseInt(process.env.FORECAST_LOOKBACK_DAYS || '60', 10);

// Rollup job cadence.
const ROLLUP_INTERVAL_MS = parseInt(
  process.env.ROLLUP_INTERVAL_MS || String(60 * 60 * 1000),
  10,
);

// Analytics read preference: route heavy aggregation reads to secondaries.
// 'secondaryPreferred' offloads the primary while staying available if no
// secondary exists (falls back to primary).
const ANALYTICS_READ_PREFERENCE = process.env.TIMESERIES_READ_PREFERENCE || 'secondaryPreferred';

module.exports = {
  isTimeseriesEnabled,
  isDualWriteEnabled,
  isReadOnlyMode,
  COLLECTION_TS,
  COLLECTION_HOURLY,
  COLLECTION_LEGACY,
  GRANULARITY,
  RAW_TTL_DAYS,
  ROLLUP_TTL_DAYS,
  FORECAST_LOOKBACK_DAYS,
  ROLLUP_INTERVAL_MS,
  ANALYTICS_READ_PREFERENCE,
};
