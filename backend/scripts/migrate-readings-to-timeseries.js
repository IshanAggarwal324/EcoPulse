#!/usr/bin/env node

/**
 * Migrate legacy `energyreadings` into the `energyreadings_ts` time-series
 * collection (Sub-module 1.3.3).
 *
 * Modes:
 *   --dry-run      (default) Count + sample-transform only; writes nothing.
 *   --apply        Perform the batched copy.
 *   --backfill-rollups  After copy, materialize hourly rollups for the window.
 *
 * Safety:
 *   - Refuses --apply when APP_READ_ONLY_MODE is false (guardrail 1.3:
 *     "Migration runs with read-only app mode flag"). Set APP_READ_ONLY_MODE=true
 *     to acknowledge that the app should be quiesced during migration.
 *   - Requires explicit --apply; never mutates by default.
 *   - Verifies row counts + aggregate sum parity after copy.
 *   - Never deletes the legacy collection (rollback = drop `energyreadings_ts`
 *     and re-run; legacy data is untouched).
 *
 * Backfill:
 *   - Legacy rows missing `source` are tagged `source: 'simulated'` when
 *     `nodeId` matches a node whose ingestionMode is simulated, else
 *     `source: 'unknown'` (per plan 1.3.3).
 *
 * Usage:
 *   node scripts/migrate-readings-to-timeseries.js --dry-run
 *   node scripts/migrate-readings-to-timeseries.js --apply
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const mongoose = require('mongoose');
const EnergyReading = require('../models/EnergyReading');
const EnergyNode = require('../models/EnergyNode');
const EnergyReadingTimeseries = require('../models/EnergyReadingTimeseries');
const timeseriesSetup = require('../services/timeseries/timeseriesSetup');
const rollupWorker = require('../workers/rollupWorker');
const { COLLECTION_LEGACY } = require('../config/timeseries');

const argv = process.argv.slice(2);
const dryRun = !argv.includes('--apply');
const backfillRollups = argv.includes('--backfill-rollups');

const BATCH_SIZE = parseInt(process.env.MIGRATE_BATCH_SIZE || '1000', 10);
// Look back N days for the initial migration (0 = all history).
const LOOKBACK_DAYS = parseInt(process.env.MIGRATE_LOOKBACK_DAYS || '0', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inferSource = async (nodeId, simulatedNodeIds) => {
  if (!nodeId) return 'unknown';
  if (simulatedNodeIds.has(String(nodeId))) return 'simulated';
  return 'unknown';
};

const transformRow = (row, source) => ({
  timestamp: row.timestamp || row.createdAt || new Date(),
  meta: {
    nodeId: row.nodeId,
    nodeIdStr: String(row.nodeId),
    source,
    providerKey: row.providerKey || null,
    deviceId: row.deviceId || null,
  },
  energyGenerated: Number(row.energyGenerated) || 0,
  energyConsumed: Number(row.energyConsumed) || 0,
  unit: row.unit === 'MW' ? 'MW' : 'kW',
});

const log = (...args) => console.log('[migrate-ts]', ...args);

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env file.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  log('connected to MongoDB');

  if (dryRun) {
    log('MODE: --dry-run (no writes will occur)');
  } else {
    if (String(process.env.APP_READ_ONLY_MODE || '').toLowerCase() !== 'true') {
      console.error(
        'Refusing to --apply: set APP_READ_ONLY_MODE=true to acknowledge the app is quiesced for migration (guardrail 1.3).',
      );
      process.exit(2);
    }
    log('MODE: --apply (APP_READ_ONLY_MODE acknowledged)');
  }

  // Ensure the target collection + indexes exist.
  const setup = await timeseriesSetup.ensureAll();
  if (!setup.ok) {
    console.error('Time-series setup failed:', setup.error);
    process.exit(3);
  }
  log('time-series collection ready:', setup);

  // Precompute the set of nodeIds whose ingestionMode is simulated (for source
  // backfill inference).
  const simulatedNodes = await EnergyNode.find({ ingestionMode: 'simulated' })
    .select('_id')
    .lean();
  const simulatedNodeIds = new Set(simulatedNodes.map((n) => String(n._id)));
  log(`inferred ${simulatedNodeIds.size} simulated node(s) for source backfill`);

  // Build the query window.
  const query = {};
  if (LOOKBACK_DAYS > 0) {
    query.timestamp = { $gte: new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000) };
  }

  const totalLegacy = await EnergyReading.countDocuments(query);
  log(`legacy rows matching window: ${totalLegacy}`);

  if (totalLegacy === 0) {
    log('nothing to migrate.');
    return { migrated: 0 };
  }

  if (dryRun) {
    // Transform + validate a sample batch without writing.
    const sample = await EnergyReading.find(query).sort({ _id: 1 }).limit(5).lean();
    for (const row of sample) {
      const source = await inferSource(row.nodeId, simulatedNodeIds);
      log('sample transform:', JSON.stringify(transformRow(row, source)));
    }
    log(`dry-run complete. ${totalLegacy} row(s) would be migrated in batches of ${BATCH_SIZE}.`);
    return { dryRun: true, wouldMigrate: totalLegacy };
  }

  // --- APPLY path ---
  let migrated = 0;
  let lastId = null;
  let aggregateCheckGen = 0;
  let aggregateCheckCon = 0;
  const start = Date.now();

  // Cursor-based batching to keep memory bounded for large collections.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batchQuery = { ...query };
    if (lastId) batchQuery._id = { $gt: lastId };

    // eslint-disable-next-line no-await-in-loop
    const batch = await EnergyReading.find(batchQuery)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (batch.length === 0) break;

    const docs = [];
    for (const row of batch) {
      // eslint-disable-next-line no-await-in-loop
      const source = row.source || (await inferSource(row.nodeId, simulatedNodeIds));
      docs.push(transformRow(row, source));
      aggregateCheckGen += Number(row.energyGenerated) || 0;
      aggregateCheckCon += Number(row.energyConsumed) || 0;
    }

    // ordered:false so one bad doc doesn't abort the batch. Time-series
    // collections are append-only; insertOne/bulkWrite insert is the supported
    // write path.
    // eslint-disable-next-line no-await-in-loop
    const result = await EnergyReadingTimeseries.collection.insertMany(docs, { ordered: false });
    migrated += result.insertedCount;
    lastId = batch[batch.length - 1]._id;

    log(`migrated ${migrated}/${totalLegacy} (last batch ${result.insertedCount})`);
    // Yield to the event loop between batches.
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }

  // --- Verification ---
  const tsCount = await EnergyReadingTimeseries.countDocuments({});
  const tsAgg = await EnergyReadingTimeseries.aggregate([
    {
      $group: {
        _id: null,
        gen: { $sum: '$energyGenerated' },
        con: { $sum: '$energyConsumed' },
      },
    },
  ]);
  const tsGen = tsAgg[0]?.gen || 0;
  const tsCon = tsAgg[0]?.con || 0;

  const durationMs = Date.now() - start;
  log('--- migration summary ---');
  log(`legacy rows in window : ${totalLegacy}`);
  log(`ts rows inserted       : ${migrated}`);
  log(`ts collection total    : ${tsCount}`);
  log(`gen sum (legacy)       : ${aggregateCheckGen}`);
  log(`gen sum (ts)           : ${tsGen}`);
  log(`con sum (legacy)       : ${aggregateCheckCon}`);
  log(`con sum (ts)           : ${tsCon}`);
  log(`duration               : ${durationMs}ms`);

  const countMismatch = migrated !== totalLegacy;
  const genMismatch = Math.abs(tsGen - aggregateCheckGen) > 0.01;
  const conMismatch = Math.abs(tsCon - aggregateCheckCon) > 0.01;

  if (countMismatch || genMismatch || conMismatch) {
    console.error(
      'VERIFICATION FAILED — row count or aggregate sums do not match. ' +
        'The legacy collection is untouched; inspect `energyreadings_ts` and re-run.',
    );
    process.exitCode = 4;
  } else {
    log('verification OK — counts and sums match.');
  }

  if (backfillRollups) {
    const from = LOOKBACK_DAYS > 0 ? new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000) : new Date(0);
    log('backfilling hourly rollups...');
    const rollupSummary = await rollupWorker.rollupWindow(from, new Date());
    log('rollup backfill:', rollupSummary);
  }

  log('rollback: `db.energyreadings_ts.drop()` then re-run. Legacy `energyreadings` is never modified.');

  return { migrated, tsCount };
}

main()
  .then(() => mongoose.connection.close())
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
