const mongoose = require('mongoose');
const {
  COLLECTION_TS,
  COLLECTION_HOURLY,
  GRANULARITY,
  RAW_TTL_DAYS,
  ROLLUP_TTL_DAYS,
} = require('../../config/timeseries');

/**
 * Idempotent time-series collection + index bootstrap (Sub-modules 1.3.1, 1.3.2).
 *
 * Runs at server startup (when TIMESERIES_ENABLED=true). Safe to call
 * repeatedly: `createCollection` no-ops if the collection exists, and
 * `createIndex` skips duplicates.
 *
 * Enforces DB-level TTL (guardrail 1.3: "TTL enforced at DB level, not
 * app-only") so storage cost is bounded even if the app is misconfigured.
 */

const isCreated = async (db, name) => {
  const infos = await db.listCollections({ name }).toArray();
  return infos.length > 0;
};

const ensureTimeseriesCollection = async (db) => {
  if (await isCreated(db, COLLECTION_TS)) {
    return { created: false, existed: true };
  }

  await db.createCollection(COLLECTION_TS, {
    timeseries: {
      timeField: 'timestamp',
      metaField: 'meta',
      granularity: GRANULARITY,
    },
    // Expire raw high-resolution readings after RAW_TTL_DAYS. Hourly rollups
    // (separate collection) preserve long-term history for analytics + AI.
    expireAfterSeconds: Number.isFinite(RAW_TTL_DAYS) && RAW_TTL_DAYS > 0
      ? RAW_TTL_DAYS * 86400
      : undefined,
  });

  return { created: true, existed: false };
};

const ensureTimeseriesIndexes = async (db) => {
  const coll = db.collection(COLLECTION_TS);

  // Primary access pattern: latest readings for a node + time-windowed scans.
  // Compound index on meta.nodeId + timestamp desc. (Secondary indexes on the
  // metaField are supported by MongoDB time-series collections.)
  await coll.createIndex(
    { 'meta.nodeId': 1, timestamp: -1 },
    { name: 'meta_nodeId_timestamp', background: true },
  );

  // Source filtering for analytics.
  await coll.createIndex(
    { 'meta.source': 1, timestamp: -1 },
    { name: 'meta_source_timestamp', background: true },
  );

  // Provider dedup lookup (public_api).
  await coll.createIndex(
    { 'meta.providerKey': 1, 'meta.externalReadingId': 1 },
    { name: 'provider_dedup', background: true, sparse: true },
  );
};

const ensureRollupCollection = async (db) => {
  if (await isCreated(db, COLLECTION_HOURLY)) {
    return { created: false, existed: true };
  }

  await db.createCollection(COLLECTION_HOURLY, {
    // Hourly rollups keep ~2 years of history; raw readings expire at 90 days.
    expireAfterSeconds: Number.isFinite(ROLLUP_TTL_DAYS) && ROLLUP_TTL_DAYS > 0
      ? ROLLUP_TTL_DAYS * 86400
      : undefined,
  });

  return { created: true, existed: false };
};

const ensureRollupIndexes = async (db) => {
  const coll = db.collection(COLLECTION_HOURLY);

  // Idempotent upsert key for the rollup worker.
  await coll.createIndex(
    { nodeId: 1, hour: 1 },
    { name: 'node_hour_unique', unique: true, background: true },
  );
  await coll.createIndex(
    { hour: -1 },
    { name: 'hour_desc', background: true },
  );
};

/**
 * Run the full bootstrap. Returns a status object. Never throws — a setup
 * failure must not crash server startup; it is surfaced as `ok: false` so the
 * admin dashboard can report it.
 */
const ensureAll = async () => {
  const db = mongoose.connection.db;
  if (!db) {
    return { ok: false, error: 'MongoDB connection db handle unavailable' };
  }

  try {
    const tsStatus = await ensureTimeseriesCollection(db);
    await ensureTimeseriesIndexes(db);
    const rollupStatus = await ensureRollupCollection(db);
    await ensureRollupIndexes(db);

    return {
      ok: true,
      timeseries: { collection: COLLECTION_TS, granularity: GRANULARITY, ...tsStatus },
      rollup: { collection: COLLECTION_HOURLY, ...rollupStatus },
      rawTtlDays: RAW_TTL_DAYS,
      rollupTtlDays: ROLLUP_TTL_DAYS,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

/**
 * Describe the current time-series setup for the admin dashboard without
 * mutating anything.
 */
const describe = async () => {
  const db = mongoose.connection.db;
  if (!db) return { ok: false, error: 'db unavailable' };

  const [tsExists, rollupExists, tsInfo] = await Promise.all([
    isCreated(db, COLLECTION_TS),
    isCreated(db, COLLECTION_HOURLY),
    db.command({ collStats: COLLECTION_TS }).catch(() => null),
  ]);

  return {
    ok: true,
    collection: COLLECTION_TS,
    rollupCollection: COLLECTION_HOURLY,
    timeseriesExists: tsExists,
    rollupExists,
    granularity: GRANULARITY,
    rawTtlDays: RAW_TTL_DAYS,
    rollupTtlDays: ROLLUP_TTL_DAYS,
    tsStats: tsInfo
      ? {
          count: tsInfo.count ?? null,
          sizeBytes: tsInfo.size ?? null,
          storageSizeBytes: tsInfo.storageSize ?? null,
          indexes: tsInfo.nindexes ?? null,
        }
      : null,
  };
};

module.exports = {
  ensureAll,
  describe,
  ensureTimeseriesCollection,
  ensureTimeseriesIndexes,
  ensureRollupCollection,
  ensureRollupIndexes,
  isCreated,
};
