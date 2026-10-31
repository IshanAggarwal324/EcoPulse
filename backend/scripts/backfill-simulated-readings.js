#!/usr/bin/env node
/**
 * Replaces old simulated energy readings with a fresh, realistic history and
 * keeps it consistent with what the live simulator produces next.
 *
 *   node scripts/backfill-simulated-readings.js [options]            (dry run, writes nothing)
 *   node scripts/backfill-simulated-readings.js [options] --send     (writes to the database)
 *
 * Options:
 *   --days <n>            History length in days (default 90)
 *   --interval-min <n>    Spacing between readings in minutes (default 15)
 *   --replace             First remove existing simulated / untagged readings in the
 *                         window (after backing them up). Without it the script stops
 *                         if such readings already exist, so it never creates duplicates.
 *   --no-backup           Skip the backup copy made by --replace (not recommended)
 *   --expect-db <name>    Refuse to run unless the connected database has this name
 *
 * Only readings with source "simulated" or no source are ever removed. Device,
 * public_api and admin readings are never touched. Every active node (status not
 * "inactive") gets readings; each node has its own nonce, so curves differ per node
 * and per owner. Uses MONGO_URI from the environment (backend/.env or the container).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const EnergyNode = require('../models/EnergyNode');
const EnergyReading = require('../models/EnergyReading');
const { computeTargets, deterministicNoise } = require('../services/simulator/profiles');
const { isTimeseriesEnabled } = require('../config/timeseries');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const DAYS = parseInt(option('--days', '90'), 10);
const INTERVAL_MIN = parseInt(option('--interval-min', '15'), 10);
const SEND = flag('--send');
const REPLACE = flag('--replace');
const NO_BACKUP = flag('--no-backup');
const EXPECT_DB = option('--expect-db', null);
const BATCH = 5000;

const round2 = (n) => Math.round(n * 100) / 100;
const SIMULATED_FILTER = { $or: [{ source: 'simulated' }, { source: null }, { source: { $exists: false } }] };

const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};

(async () => {
  if (!Number.isFinite(DAYS) || DAYS < 1 || DAYS > 730) fail('--days must be between 1 and 730');
  if (!Number.isFinite(INTERVAL_MIN) || INTERVAL_MIN < 1 || INTERVAL_MIN > 240) fail('--interval-min must be between 1 and 240');
  if (!process.env.MONGO_URI) fail('MONGO_URI is not set');
  if (isTimeseriesEnabled()) {
    fail('TIMESERIES_ENABLED=true: this script writes the legacy energyreadings collection only. Turn it off or extend the script first.');
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const dbName = mongoose.connection.db.databaseName;
  if (EXPECT_DB && EXPECT_DB !== dbName) fail(`Connected to database "${dbName}" but --expect-db is "${EXPECT_DB}". Nothing was changed.`);

  const nodes = await EnergyNode.find({ status: { $ne: 'inactive' } }).lean();
  if (nodes.length === 0) fail(`No active nodes in database "${dbName}". Create nodes first.`);

  const end = new Date();
  end.setSeconds(0, 0);
  const start = new Date(end.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const stepMs = INTERVAL_MIN * 60 * 1000;
  const slots = Math.floor((end.getTime() - start.getTime()) / stepMs) + 1;
  const totalRows = slots * nodes.length;

  const existingFilter = { ...SIMULATED_FILTER, timestamp: { $gte: start } };
  const existingCount = await EnergyReading.countDocuments(existingFilter);
  const allSimulatedCount = await EnergyReading.countDocuments(SIMULATED_FILTER);
  const otherSourceCount = await EnergyReading.countDocuments({ source: { $in: ['device', 'public_api', 'admin'] } });

  console.log(`Database:            ${dbName}`);
  console.log(`Active nodes:        ${nodes.length} (${nodes.map((n) => `${n.name}:${n.sourceType}`).join(', ')})`);
  console.log(`Window:              ${start.toISOString()} -> ${end.toISOString()} (${DAYS} days, every ${INTERVAL_MIN} min)`);
  console.log(`Rows to insert:      ${totalRows}`);
  console.log(`Existing simulated/untagged readings in window: ${existingCount} (all time: ${allSimulatedCount})`);
  console.log(`Device/public/admin readings (never touched):   ${otherSourceCount}`);
  console.log(`Mode:                ${REPLACE ? 'REPLACE (backup, delete old simulated, insert new)' : 'ADD (insert only)'}\n`);

  if (existingCount > 0 && !REPLACE) {
    fail('Simulated readings already exist in this window. Re-run with --replace (a backup is taken first) so duplicates are not created.');
  }

  if (!SEND) {
    console.log('Dry run only. Nothing was changed. Add --send to apply.');
    await mongoose.disconnect();
    return;
  }

  if (REPLACE && allSimulatedCount > 0) {
    if (!NO_BACKUP) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const backupName = `energyreadings_backup_${stamp}`;
      console.log(`Backing up ${allSimulatedCount} old readings into collection "${backupName}"...`);
      await EnergyReading.collection.aggregate([{ $match: SIMULATED_FILTER }, { $out: backupName }]).toArray();
      console.log('Backup done. Drop it later when you no longer need it (it uses database storage).');
    }
    const del = await EnergyReading.deleteMany(SIMULATED_FILTER);
    console.log(`Deleted ${del.deletedCount} old simulated/untagged readings.`);
  }

  let inserted = 0;
  for (const node of nodes) {
    let batch = [];
    for (let ts = start.getTime(); ts <= end.getTime(); ts += stepMs) {
      const at = new Date(ts);
      const target = computeTargets(node, at);
      const noise = deterministicNoise(node, at);
      batch.push({
        nodeId: node._id,
        energyGenerated: round2(Math.max(0, target.energyGenerated * noise.generated)),
        energyConsumed: round2(Math.max(0, target.energyConsumed * noise.consumed)),
        timestamp: at,
        source: 'simulated',
        unit: 'kW',
      });
      if (batch.length >= BATCH) {
        await EnergyReading.insertMany(batch, { ordered: false });
        inserted += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await EnergyReading.insertMany(batch, { ordered: false });
      inserted += batch.length;
    }
    console.log(`  ${node.name} (${node.sourceType}): done`);
  }

  console.log(`\nInserted ${inserted} readings. Total readings now: ${await EnergyReading.countDocuments()}.`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(`ERROR: ${err.message}`);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
