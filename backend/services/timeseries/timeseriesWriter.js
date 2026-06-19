const EnergyReadingTimeseries = require('../../models/EnergyReadingTimeseries');
const { isTimeseriesEnabled, isDualWriteEnabled, COLLECTION_LEGACY } = require('../../config/timeseries');

/**
 * Dual-write bridge from the unified ingest pipeline to the time-series
 * collection (Sub-module 1.3.1 — "augment" EnergyReading).
 *
 * Behaviour:
 *  - If `TIMESERIES_ENABLED=false` → no-op (legacy `energyreadings` is the only
 *    store; pre-1.3 behavior preserved exactly).
 *  - If enabled + dual-write ON → also insert into `energyreadings_ts`.
 *  - If enabled + dual-write OFF → caller is responsible for NOT writing to
 *    legacy; this helper writes only to TS. (Used after cutover in 1.4.)
 *
 * `meta` is rebuilt from a strict whitelist — only nodeId / source /
 * providerKey / deviceId. This enforces the guardrail "No PII in time-series
 * meta — only ObjectIds and source enums" regardless of what the caller passes.
 */

const META_WHITELIST = ['nodeId', 'nodeIdStr', 'source', 'providerKey', 'deviceId'];

const sanitizeMeta = (nodeId, source, provenance) => ({
  nodeId,
  // String copy for efficient $match without ObjectId coercion in some pipelines.
  nodeIdStr: String(nodeId),
  source: source || 'unknown',
  providerKey: provenance?.providerKey || null,
  deviceId: provenance?.deviceId || null,
});

/**
 * Insert a reading into the time-series collection.
 *
 * @returns {object|null} the inserted TS document, or null if disabled/error.
 *          Never throws — a TS write failure must not break the primary ingest
 *          path (legacy collection is the source of truth during dual-write).
 */
const writeToTimeseries = async ({
  nodeId,
  energyGenerated,
  energyConsumed,
  timestamp,
  source,
  unit,
  provenance,
}) => {
  if (!isTimeseriesEnabled()) return null;

  const doc = {
    timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp || Date.now()),
    meta: sanitizeMeta(nodeId, source, provenance),
    energyGenerated,
    energyConsumed,
    unit: unit === 'MW' ? 'MW' : 'kW',
  };

  try {
    await EnergyReadingTimeseries.collection.insertOne(doc);
    return doc;
  } catch (err) {
    console.error('[timeseries] write failed (non-fatal, legacy store is authoritative):', err.message);
    return null;
  }
};

/**
 * Whether the legacy collection should still receive the write. During
 * dual-write (default) yes; post-cutover (dual-write off) the legacy write is
 * skipped and only TS is written.
 */
const shouldWriteLegacy = () => {
  if (!isTimeseriesEnabled()) return true;
  return isDualWriteEnabled();
};

module.exports = {
  writeToTimeseries,
  shouldWriteLegacy,
  sanitizeMeta,
  META_WHITELIST,
  COLLECTION_LEGACY,
};
