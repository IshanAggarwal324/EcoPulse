#!/usr/bin/env node
/**
 * Rebuilds the stored (MongoDB) copy of escrows and disputes from the chain.
 *
 * Why: before the fix, every state change (delivered, released, disputed,
 * refunded) overwrote the escrow's buyer, seller, amount and listing id with
 * null, so older records can be incomplete. The chain is the source of truth, so
 * this script clears the stored copies for the CURRENT escrow/dispute contracts
 * and rewinds the escrow sync marker; the backend's background sync (every ~60 s)
 * then re-reads every event with the corrected indexer.
 *
 *   node scripts/rebuild-escrow-mirror.js                  (dry run, changes nothing)
 *   node scripts/rebuild-escrow-mirror.js --send           (apply)
 *   node scripts/rebuild-escrow-mirror.js --send --from-block 12028253
 *
 * Needs MONGO_URI, ENERGY_ESCROW_ADDRESS, DISPUTE_RESOLUTION_ADDRESS in the
 * environment (they are set inside the backend container). The rewind block comes
 * from --from-block, else BLOCKCHAIN_SYNC_FROM_BLOCK. Only escrow/dispute copies
 * for the current contracts are touched. No funds or on-chain data are affected.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const Escrow = require('../models/Escrow');
const Dispute = require('../models/Dispute');
const SyncState = require('../models/SyncState');

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const fromIdx = args.indexOf('--from-block');
const FROM_BLOCK = parseInt(fromIdx >= 0 ? args[fromIdx + 1] : process.env.BLOCKCHAIN_SYNC_FROM_BLOCK || '', 10);
const ESCROW_SYNC_STATE_KEY = 'energy_escrow';

const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};

(async () => {
  const escrowAddress = String(process.env.ENERGY_ESCROW_ADDRESS || '').trim().toLowerCase();
  const disputeAddress = String(process.env.DISPUTE_RESOLUTION_ADDRESS || '').trim().toLowerCase();
  if (!process.env.MONGO_URI) fail('MONGO_URI is not set');
  if (!escrowAddress || !disputeAddress) fail('ENERGY_ESCROW_ADDRESS and DISPUTE_RESOLUTION_ADDRESS must be set');
  if (!Number.isFinite(FROM_BLOCK) || FROM_BLOCK < 0) {
    fail('No starting block. Pass --from-block <n> or set BLOCKCHAIN_SYNC_FROM_BLOCK (the block the contracts were deployed at).');
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const dbName = mongoose.connection.db.databaseName;

  const escrowFilter = { contractAddress: escrowAddress };
  const disputeFilter = { contractAddress: disputeAddress };
  const [escrows, disputes, state] = await Promise.all([
    Escrow.countDocuments(escrowFilter),
    Dispute.countDocuments(disputeFilter),
    SyncState.findOne({ key: ESCROW_SYNC_STATE_KEY }).lean(),
  ]);
  const broken = await Escrow.countDocuments({
    ...escrowFilter,
    $or: [{ buyer: null }, { seller: null }, { amount: null }, { listingId: null }],
  });

  console.log(`Database:               ${dbName}`);
  console.log(`Escrow contract:        ${escrowAddress}`);
  console.log(`Stored escrows:         ${escrows} (${broken} with missing buyer/seller/amount/listing)`);
  console.log(`Stored disputes:        ${disputes}`);
  console.log(`Escrow sync marker:     block ${state ? state.lastSyncedBlock : 'none'} -> will rewind to ${FROM_BLOCK}\n`);

  if (!SEND) {
    console.log('Dry run only. Nothing was changed. Add --send to apply.');
    await mongoose.disconnect();
    return;
  }

  const delEscrows = await Escrow.deleteMany(escrowFilter);
  const delDisputes = await Dispute.deleteMany(disputeFilter);
  await SyncState.updateOne({ key: ESCROW_SYNC_STATE_KEY }, { $set: { lastSyncedBlock: FROM_BLOCK } }, { upsert: true });

  console.log(`Deleted ${delEscrows.deletedCount} stored escrows and ${delDisputes.deletedCount} stored disputes.`);
  console.log(`Sync marker set to block ${FROM_BLOCK}. The backend rebuilds them from the chain within about a minute.`);
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
