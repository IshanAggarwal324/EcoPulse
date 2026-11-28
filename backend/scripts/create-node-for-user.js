#!/usr/bin/env node
/**
 * Creates an energy node owned by an existing user, looked up by email. Use it
 * when an account has no node (so the forecast shows "no nodes") and the admin
 * console is not convenient.
 *
 *   node scripts/create-node-for-user.js --email <email> --name "Demo Solar Farm"            (dry run)
 *   node scripts/create-node-for-user.js --email <email> --name "Demo Solar Farm" --send     (creates it)
 *
 * Options:
 *   --email <email>     Owner's account email (required; the account must already exist)
 *   --name <text>       Node name (required)
 *   --source <type>     solar | wind | home | industry | other   (default solar)
 *   --type <type>       producer | consumer | prosumer           (default producer)
 *   --status <status>   active | inactive | maintenance | failed (default active)
 *   --expect-db <name>  Refuse to run unless the connected database has this name
 *
 * Safe to re-run: it refuses to create a second node with the same name for the
 * same owner. After creating the node, fill its history with
 *   node scripts/backfill-simulated-readings.js --new-nodes-only --days 365 --interval-min 60 --send
 * and then restart the simulator in the admin console.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const EnergyNode = require('../models/EnergyNode');
const User = require('../models/User');

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const SEND = args.includes('--send');

const SOURCES = ['solar', 'wind', 'home', 'industry', 'other'];
const TYPES = ['producer', 'consumer', 'prosumer'];
const STATUSES = ['active', 'inactive', 'maintenance', 'failed'];

const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};

(async () => {
  const email = String(option('--email') || '').trim().toLowerCase();
  const name = String(option('--name') || '').trim();
  const sourceType = option('--source', 'solar');
  const nodeType = option('--type', 'producer');
  const status = option('--status', 'active');
  const expectDb = option('--expect-db');

  if (!email || !name) fail('Usage: node scripts/create-node-for-user.js --email <email> --name "<node name>" [--source solar] [--type producer] [--send]');
  if (!SOURCES.includes(sourceType)) fail(`--source must be one of: ${SOURCES.join(', ')}`);
  if (!TYPES.includes(nodeType)) fail(`--type must be one of: ${TYPES.join(', ')}`);
  if (!STATUSES.includes(status)) fail(`--status must be one of: ${STATUSES.join(', ')}`);
  if (!process.env.MONGO_URI) fail('MONGO_URI is not set');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const dbName = mongoose.connection.db.databaseName;
  if (expectDb && expectDb !== dbName) fail(`Connected to database "${dbName}" but --expect-db is "${expectDb}". Nothing was changed.`);

  const user = await User.findOne({ email }).select('_id name email role').lean();
  if (!user) fail(`No account with email "${email}" in database "${dbName}". The person must register first.`);

  const ownedCount = await EnergyNode.countDocuments({ userId: user._id });
  const duplicate = await EnergyNode.findOne({ userId: user._id, name }).select('_id').lean();

  console.log(`Database:      ${dbName}`);
  console.log(`Owner:         ${user.name || '(no name)'} <${user.email}> role=${user.role}`);
  console.log(`Owner's nodes: ${ownedCount} existing`);
  console.log(`New node:      "${name}" (${nodeType}, ${sourceType}, ${status})\n`);

  if (duplicate) fail(`This owner already has a node named "${name}" (id ${duplicate._id}). Nothing was changed.`);

  if (!SEND) {
    console.log('Dry run only. Nothing was changed. Add --send to create the node.');
    await mongoose.disconnect();
    return;
  }

  const node = await EnergyNode.create({ name, nodeType, sourceType, status, userId: user._id });
  console.log(`Created node ${node._id} for ${user.email}.`);
  console.log('Next: fill its history, then restart the simulator (see the header of this script).');
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
