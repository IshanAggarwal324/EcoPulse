#!/usr/bin/env node

/**
 * Module 8.4 — wallet address index readiness migration.
 *
 * `User.walletAddress` becomes `unique + sparse` so two accounts can never claim
 * the same wallet (the source of truth for carbon/settlements). Before that
 * index can be created reliably this script:
 *
 *   1. lowercases every stored wallet address (the field now normalizes on save,
 *      but legacy rows may hold mixed/checksummed case), and
 *   2. reports (and, with --apply, clears to null) any DUPLICATE non-null
 *      addresses — duplicates would block unique-index creation and indicate a
 *      pre-8.4 double-claim that must be resolved by an operator.
 *
 * Idempotent. Safe to run in production. DRY-RUN by default; pass --apply to
 * persist. Pass --keep-duplicates with --apply to only normalize case while
 * leaving duplicates in place (index creation will then fail loudly — useful if
 * you prefer to resolve dupes manually first).
 *
 *   node scripts/migrate-wallet-address-index.js               # report
 *   node scripts/migrate-wallet-address-index.js --apply        # normalize + clear dupes
 *   node scripts/migrate-wallet-address-index.js --apply --keep-duplicates
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const mongoose = require('mongoose');

const isApply = process.argv.includes('--apply');
const keepDuplicates = process.argv.includes('--keep-duplicates');

function redactUri(uri) {
  if (!uri || typeof uri !== 'string') return '<unset>';
  return uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env file.');
    process.exit(1);
  }

  console.log(`Target database : ${redactUri(process.env.MONGO_URI)}`);
  console.log(`Mode            : ${isApply ? 'APPLY (writes will persist)' : 'DRY-RUN (no writes)'}`);
  console.log(`Keep duplicates : ${keepDuplicates ? 'yes (case-normalize only)' : 'no (dupes -> null)'}`);
  console.log('');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  try {
    const Users = mongoose.connection.collection('users');
    const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

    // 1) Normalize case for valid addresses.
    const all = await Users.find(
      { walletAddress: { $type: 'string' } },
      { projection: { _id: 1, walletAddress: 1, email: 1 } },
    ).toArray();

    let normalizedCount = 0;
    let invalidCount = 0;
    const byLower = new Map();

    for (const u of all) {
      const raw = String(u.walletAddress || '').trim();
      if (!raw) continue;
      const lower = raw.toLowerCase();
      if (!ADDRESS_RE.test(raw)) {
        invalidCount++;
        continue;
      }
      if (raw !== lower) {
        normalizedCount++;
        if (isApply) {
          await Users.updateOne({ _id: u._id }, { $set: { walletAddress: lower } });
        }
      }
      if (!byLower.has(lower)) byLower.set(lower, []);
      byLower.get(lower).push(u);
    }

    console.log(`Wallets scanned          : ${all.length}`);
    console.log(`Case-normalized          : ${normalizedCount}`);
    console.log(`Structurally invalid     : ${invalidCount} (left untouched)`);

    // 2) Duplicate detection (post-normalization view).
    const dupes = [...byLower.entries()].filter(([, users]) => users.length > 1);
    console.log(`Duplicate addresses      : ${dupes.length}`);

    if (dupes.length) {
      console.log('\nDuplicate groups (all but one will be cleared on --apply):');
      for (const [addr, users] of dupes) {
        console.log(`  ${addr}`);
        for (const u of users) {
          console.log(`     - ${u._id}  ${u.email || ''}`);
        }
      }
    }

    if (dupes.length && isApply && !keepDuplicates) {
      let cleared = 0;
      for (const [addr, users] of dupes) {
        // Keep the newest (by _id is not strictly chronological; sort by _id desc
        // as a deterministic tiebreak). Older claims are cleared to null.
        const sorted = [...users].sort((a, b) => String(b._id).localeCompare(String(a._id)));
        const losers = sorted.slice(1);
        for (const u of losers) {
          await Users.updateOne({ _id: u._id }, { $set: { walletAddress: null, walletLinkedAt: null } });
          cleared++;
        }
      }
      console.log(`\nDuplicate claims cleared : ${cleared} (newest kept per address)`);
    }

    if (invalidCount) {
      console.warn(`\nWARNING: ${invalidCount} wallet(s) are structurally invalid. Review manually before creating the unique index.`);
    }

    if (!isApply) {
      console.log('\nDry-run complete. Re-run with --apply to persist.');
    }
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
