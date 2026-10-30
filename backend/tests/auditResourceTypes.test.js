const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AuditLog = require('../models/AuditLog');

/*
 * auditService.log() swallows validation errors, so any resourceType missing from
 * the AuditLog enum means that event is silently never recorded. These tests keep
 * the model and the call sites in sync.
 */

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'scripts', 'coverage']);

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
};

test('every resourceType literal used by the backend is accepted by the AuditLog model', () => {
  const allowed = new Set(AuditLog.schema.path('resourceType').enumValues);
  const used = new Map();

  for (const file of walk(BACKEND_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/resourceType:\s*'([A-Za-z_]+)'/g)) {
      if (!used.has(match[1])) used.set(match[1], path.relative(BACKEND_ROOT, file));
    }
  }

  assert.ok(used.size > 5, 'expected to find resourceType usages');
  const rejected = [...used].filter(([type]) => !allowed.has(type));
  assert.deepEqual(
    rejected,
    [],
    `these resourceType values would be silently dropped by auditService.log(): ${JSON.stringify(rejected)}`,
  );
});

test('previously dropped event types now validate', () => {
  for (const resourceType of ['ingestion', 'public_grid', 'grid_zone', 'listing_intent', 'buyOrder', 'dispute']) {
    const error = new AuditLog({ action: 'TEST', resourceType }).validateSync();
    assert.equal(error, undefined, `${resourceType} should be accepted`);
  }
  const bad = new AuditLog({ action: 'TEST', resourceType: 'not_a_type' }).validateSync();
  assert.ok(bad, 'unknown types must still be rejected');
});

/* ------------------------------------------------------------------ */
/* verifyChain with entries that have aged out of the retention window */
/* ------------------------------------------------------------------ */

const buildChain = (count, { startPrev = null } = {}) => {
  const entries = [];
  let prev = startPrev;
  for (let i = 0; i < count; i += 1) {
    const entry = {
      _id: `id${i}`,
      actorId: null,
      actorEmail: 'admin@example.com',
      actorRole: 'admin',
      action: `ACTION_${i}`,
      resourceType: 'user',
      resourceId: String(i),
      severity: 'info',
      ip: '127.0.0.1',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      prevHash: prev,
    };
    entry.entryHash = AuditLog.computeHash(entry, prev);
    prev = entry.entryHash;
    entries.push(entry);
  }
  return entries;
};

const withEntries = async (entries, fn) => {
  const original = AuditLog.find;
  AuditLog.find = () => ({
    sort: () => ({ limit: () => ({ select: () => ({ lean: async () => entries }) }) }),
  });
  try {
    return await fn();
  } finally {
    AuditLog.find = original;
  }
};

test('verifyChain: an intact chain starting at the very first entry is clean', async () => {
  const result = await withEntries(buildChain(5), () => AuditLog.verifyChain(100));
  assert.equal(result.totalChecked, 5);
  assert.equal(result.brokenCount, 0);
});

test('verifyChain: a chain whose oldest entries expired (TTL) is not reported as broken', async () => {
  const full = buildChain(6);
  const retained = full.slice(2); // entries 0 and 1 expired; entry 2 still points at entry 1's hash
  const result = await withEntries(retained, () => AuditLog.verifyChain(100));
  assert.equal(result.brokenCount, 0, `unexpected breaks: ${JSON.stringify(result.broken)}`);
});

test('verifyChain still detects a tampered entry and a removed middle entry', async () => {
  const tampered = buildChain(5).map((e) => ({ ...e }));
  tampered[2].action = 'SOMETHING_ELSE'; // content changed, hash no longer matches
  const t = await withEntries(tampered, () => AuditLog.verifyChain(100));
  assert.ok(t.brokenCount >= 1);
  assert.ok(t.broken.some((b) => b.reason === 'hash_mismatch' && b.id === 'id2'));

  const gap = buildChain(5);
  gap.splice(2, 1); // an entry in the middle vanished
  const g = await withEntries(gap, () => AuditLog.verifyChain(100));
  assert.ok(g.broken.some((b) => b.reason === 'chain_broken'), 'a missing middle entry must break the chain');
});
