#!/usr/bin/env node

/**
 * Backfill the SHA-256 hash chain onto existing AuditLog entries.
 *
 * Audit entries created before the integrity-chain feature have no
 * `entryHash` / `prevHash`. This script links them into a verifiable chain
 * so `GET /admin/audit-logs/verify` covers historical data too.
 *
 * Modes:
 *   (default)  Fill only entries missing an entryHash. Existing, already-hashed
 *              entries are preserved and the new segment is chained off the
 *              most recent existing hash — non-destructive.
 *   --rebuild  Recompute the hash for EVERY entry from scratch (fresh genesis).
 *              Use only if the existing chain is known-broken and you want to
 *              re-establish it. Overwrites all existing hashes.
 *
 * Uses the raw MongoDB driver collection, which bypasses the AuditLog
 * append-only Mongoose middleware (see models/AuditLog.js).
 *
 * Usage:
 *   node scripts/backfill-audit-hashes.js [--rebuild] [--dry-run]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');

const argv = process.argv.slice(2);
const rebuild = argv.includes('--rebuild');
const dryRun = argv.includes('--dry-run');

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env file.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to MongoDB${dryRun ? ' (DRY RUN — no writes)' : ''}.`);

  const collection = AuditLog.collection;

  const filter = rebuild ? {} : { entryHash: null };
  const total = await collection.countDocuments(filter);
  if (total === 0) {
    console.log('No audit entries need backfilling. Nothing to do.');
    return;
  }
  console.log(`Found ${total} entries to ${rebuild ? 'rebuild' : 'backfill'}.`);

  // Walk chronologically. For non-rebuild, anchor the chain on the most recent
  // existing entryHash so the new segment links continuously to old data.
  let prevHash = null;
  if (!rebuild) {
    const anchor = await collection
      .findOne({ entryHash: { $ne: null } }, { sort: { createdAt: -1, _id: -1 } });
    if (anchor) {
      prevHash = anchor.entryHash;
      console.log(`Chaining new segment off existing hash: ${prevHash.slice(0, 12)}…`);
    }
  }

  const cursor = collection.find(filter, { sort: { createdAt: 1, _id: 1 } });
  let processed = 0;
  let doc;

  while ((doc = await cursor.next())) {
    const entryForHash = {
      actorId: doc.actorId,
      actorEmail: doc.actorEmail,
      actorRole: doc.actorRole,
      action: doc.action,
      resourceType: doc.resourceType,
      resourceId: doc.resourceId,
      severity: doc.severity,
      ip: doc.ip,
      createdAt: doc.createdAt,
    };

    const entryHash = AuditLog.computeHash(entryForHash, prevHash);

    if (!dryRun) {
      await collection.updateOne(
        { _id: doc._id },
        { $set: { prevHash, entryHash } }
      );
    }

    prevHash = entryHash;
    processed += 1;
    if (processed % 500 === 0) {
      console.log(`  …processed ${processed}/${total}`);
    }
  }

  console.log(
    `\nDone. ${processed} entries ${dryRun ? 'would be ' : ''}${rebuild ? 'rebuilt' : 'backfilled'}. ` +
      `Final chain hash: ${prevHash ? prevHash.slice(0, 16) + '…' : '(none)'}`
  );

  if (!dryRun) {
    const verify = await AuditLog.verifyChain();
    console.log(`Post-run verification: ${verify.totalChecked} checked, ${verify.brokenCount} broken.`);
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  });
