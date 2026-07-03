#!/usr/bin/env node

/**
 * Module 8.1 — one-time role migration.
 *
 * Maps the pre-8.1 enum (`user | admin | moderator`) onto the new domain
 * personas (`consumer | prosumer | grid_operator | admin | moderator`):
 *
 *   user        -> consumer   (the least-privileged base persona)
 *   admin       -> admin      (unchanged)
 *   moderator   -> moderator  (unchanged)
 *
 * Idempotent: re-running is a no-op once no `user` documents remain.
 *
 * This script is SAFE to run in production and is the intended deploy step, so
 * it does NOT use the ALLOW_DEV_SCRIPTS gate. To prevent accidental mass writes
 * it runs in DRY-RUN mode by default; pass `--apply` to persist changes.
 *
 *   node scripts/migrate-user-roles.js            # dry-run report
 *   node scripts/migrate-user-roles.js --apply    # write changes
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const mongoose = require('mongoose');
const { LEGACY_ROLE_MAP } = require('../auth/roles');

const isApply = process.argv.includes('--apply');
const LEGACY_ROLE = 'user';
const NEW_ROLE = LEGACY_ROLE_MAP[LEGACY_ROLE]; // 'consumer'

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
  console.log(`Mapping         : ${LEGACY_ROLE} -> ${NEW_ROLE}`);
  console.log('');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  try {
    const User = mongoose.connection.collection('users');
    const match = { role: LEGACY_ROLE };
    const [matched, byRole] = await Promise.all([
      User.countDocuments(match),
      User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]).toArray(),
    ]);

    console.log('\nCurrent role distribution:');
    for (const { _id, count } of byRole) {
      console.log(`  ${String(_id).padEnd(16)} ${count}`);
    }

    console.log(`\nUsers to migrate (${LEGACY_ROLE} -> ${NEW_ROLE}): ${matched}`);

    if (matched === 0) {
      console.log('Nothing to migrate. Database is already on the new role model.');
      return;
    }

    if (!isApply) {
      console.log('\nDry-run complete. Re-run with --apply to persist the migration.');
      return;
    }

    const result = await User.updateMany(match, { $set: { role: NEW_ROLE } });
    console.log(`\nMigration applied: ${result.modifiedCount} user(s) updated to "${NEW_ROLE}".`);

    const remaining = await User.countDocuments(match);
    if (remaining > 0) {
      console.warn(`WARNING: ${remaining} user(s) still have role "${LEGACY_ROLE}". Review manually.`);
    } else {
      console.log('Verified: no remaining legacy "user" roles.');
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
