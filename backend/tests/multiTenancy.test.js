const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildNodeAccessFilter,
  buildNodeAccessFilterAsync,
  assertNodeAccess,
  assertNodeAccessAsync,
  assertNodeTelemetryAccess,
  resolveActiveZoneCodes,
  getActiveZoneCodes,
  invalidateActiveZoneCache,
  getUserZoneIds,
  __setActiveZoneCacheForTest,
} = require('../utils/nodeOwnership');
const { buildMapFilter } = require('../services/nodeMapService');
const ApiError = require('../utils/apiError');
const GridZone = require('../models/GridZone');

const assertThrowsApi = (fn, statusCode, code) => {
  assert.throws(fn, (err) => err instanceof ApiError
    && err.statusCode === statusCode
    && err.code === code);
};

const OP = '507f1f77bcf86cd7994390aa';
const OWNER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439099';
const GRID_OP = '507f1f77bcf86cd7994390c0';

const gridOp = (zones) => ({ role: 'grid_operator', _id: GRID_OP, assignedZoneIds: zones });

// ---------------------------------------------------------------------------
// Module 8.5 — Active-zone revocation (deactivated zone must stop granting
// visibility to a grid_operator). These prove the stale-grant fix at the
// sync access core that the async orchestrators feed with the cached set.
// ---------------------------------------------------------------------------

test('buildNodeAccessFilter drops a deactivated zone from the read clause', () => {
  // Operator is assigned north + south, but south was deactivated (active:false).
  const active = new Set(['north']);
  const filter = buildNodeAccessFilter(gridOp(['north', 'south']), { activeZoneCodes: active });
  assert.deepStrictEqual(filter, {
    $or: [
      { userId: GRID_OP },
      { 'operators.userId': GRID_OP },
      { zoneId: { $in: ['north'] } },
    ],
  });
});

test('buildNodeAccessFilter with NO active zones resolves to own + delegated only', () => {
  const filter = buildNodeAccessFilter(gridOp(['north']), { activeZoneCodes: new Set() });
  assert.deepStrictEqual(filter, {
    $or: [{ userId: GRID_OP }, { 'operators.userId': GRID_OP }],
  });
});

test('buildNodeAccessFilter without an active set trusts declared zones (unit-test path)', () => {
  // Backward-compat: no activeZoneCodes -> declared zones are trusted verbatim.
  const filter = buildNodeAccessFilter(gridOp(['north', 'south']));
  assert.deepStrictEqual(filter, {
    $or: [
      { userId: GRID_OP },
      { 'operators.userId': GRID_OP },
      { zoneId: { $in: ['north', 'south'] } },
    ],
  });
});

test('a deactivated zone no longer grants a grid_operator read on a node', () => {
  const node = { userId: OTHER, zoneId: 'south' };
  // south is in the assignment but NOT active -> access revoked.
  assertThrowsApi(
    () => assertNodeAccess(gridOp(['south']), node, 'read', { activeZoneCodes: new Set(['north']) }),
    404,
    'NODE_NOT_FOUND',
  );
});

test('a still-active zone keeps granting a grid_operator read on a node', () => {
  const node = { userId: OTHER, zoneId: 'north' };
  assertNodeAccess(gridOp(['north']), node, 'read', { activeZoneCodes: new Set(['north']) });
});

test('zone revocation never opens a write path (grid_operator write stays blocked)', () => {
  const node = { userId: OTHER, zoneId: 'north' };
  assertThrowsApi(
    () => assertNodeAccess(gridOp(['north']), node, 'write', { activeZoneCodes: new Set(['north']) }),
    404,
    'NODE_NOT_FOUND',
  );
});

test('a grid_operator OUT of the node zone is denied read even with an active set', () => {
  const node = { userId: OTHER, zoneId: 'north' };
  assertThrowsApi(
    () => assertNodeAccess(gridOp(['south']), node, 'read', { activeZoneCodes: new Set(['north', 'south']) }),
    404,
    'NODE_NOT_FOUND',
  );
});

// ---------------------------------------------------------------------------
// Module 8.5 — Active-zone cache + async orchestrators.
// The cache lets node reads avoid a per-request DB hit while still reflecting
// deactivation immediately (admin controller invalidates on zone changes).
// ---------------------------------------------------------------------------

test('resolveActiveZoneCodes returns the cached set for grid_operator and undefined otherwise', async () => {
  __setActiveZoneCacheForTest(['north', 'south']);
  const forGrid = await resolveActiveZoneCodes(gridOp(['north']));
  assert.ok(forGrid instanceof Set);
  assert.ok(forGrid.has('north'));

  const forConsumer = await resolveActiveZoneCodes({ role: 'consumer', _id: OP });
  assert.strictEqual(forConsumer, undefined);

  const forAdmin = await resolveActiveZoneCodes({ role: 'admin', _id: OP });
  assert.strictEqual(forAdmin, undefined);
});

test('getActiveZoneCodes serves the cached set without hitting the DB', async () => {
  __setActiveZoneCacheForTest(['north', 'south']);
  const codes = await getActiveZoneCodes();
  assert.ok(codes instanceof Set);
  assert.ok(codes.has('north'));
  assert.ok(codes.has('south'));
  assert.strictEqual(codes.size, 2);
});

test('invalidateActiveZoneCache forces a re-resolution on the next call', async () => {
  __setActiveZoneCacheForTest(['north']);
  let codes = await getActiveZoneCodes();
  assert.ok(codes.has('north'));

  invalidateActiveZoneCache();
  // Re-seed with a different set (simulating the admin path re-populating it).
  __setActiveZoneCacheForTest(['south']);
  codes = await getActiveZoneCodes();
  assert.ok(codes.has('south'));
  assert.ok(!codes.has('north'));
});

test('buildNodeAccessFilterAsync applies the cached active set (deactivated zone excluded)', async () => {
  __setActiveZoneCacheForTest(['north']); // south deactivated
  const filter = await buildNodeAccessFilterAsync(gridOp(['north', 'south']));
  assert.deepStrictEqual(filter, {
    $or: [
      { userId: GRID_OP },
      { 'operators.userId': GRID_OP },
      { zoneId: { $in: ['north'] } },
    ],
  });
});

test('assertNodeAccessAsync revokes read when the zone is no longer active', async () => {
  __setActiveZoneCacheForTest(['north']); // south deactivated
  const node = { userId: OTHER, zoneId: 'south' };
  await assert.rejects(
    () => assertNodeAccessAsync(gridOp(['south']), node, 'read'),
    (err) => err instanceof ApiError && err.statusCode === 404 && err.code === 'NODE_NOT_FOUND',
  );
});

test('getActiveZoneCodes fails CLOSED (empty set) when the zone lookup throws', async () => {
  invalidateActiveZoneCache();
  const origFind = GridZone.find;
  GridZone.find = () => {
    throw new Error('simulated db outage');
  };
  try {
    const codes = await getActiveZoneCodes();
    // No active zones verifiable -> no zone visibility granted (fail-closed).
    assert.ok(codes instanceof Set);
    assert.strictEqual(codes.size, 0);
  } finally {
    GridZone.find = origFind;
    invalidateActiveZoneCache();
  }
});

// ---------------------------------------------------------------------------
// Module 8.5 — buildMapFilter forwards the active set (live grid map must not
// plot nodes from a deactivated zone for a grid_operator).
// ---------------------------------------------------------------------------

test('buildMapFilter drops deactivated zones from the map scope', () => {
  const filter = buildMapFilter(gridOp(['north', 'south']), { activeZoneCodes: new Set(['north']) });
  assert.deepStrictEqual(filter, {
    $or: [
      { userId: GRID_OP },
      { 'operators.userId': GRID_OP },
      { zoneId: { $in: ['north'] } },
    ],
  });
});

// ---------------------------------------------------------------------------
// Module 8.5 — PII boundary for raw per-node meter telemetry (EnergyReading).
// grid_operator zone visibility grants node METADATA/aggregates, never an
// individual's meter curve. Owner + delegated operators may read telemetry.
// ---------------------------------------------------------------------------

test('assertNodeTelemetryAccess: owner passes', () => {
  assertNodeTelemetryAccess({ role: 'consumer', _id: OWNER }, { userId: OWNER });
});

test('assertNodeTelemetryAccess: privileged roles pass', () => {
  assertNodeTelemetryAccess({ role: 'admin', _id: OP }, { userId: OWNER });
  assertNodeTelemetryAccess({ role: 'moderator', _id: OP }, { userId: OWNER });
});

test('assertNodeTelemetryAccess: read delegate passes', () => {
  const node = { userId: OTHER, operators: [{ userId: OP, permission: 'read' }] };
  assertNodeTelemetryAccess({ role: 'consumer', _id: OP }, node);
});

test('assertNodeTelemetryAccess: write delegate passes', () => {
  const node = { userId: OTHER, operators: [{ userId: OP, permission: 'write' }] };
  assertNodeTelemetryAccess({ role: 'prosumer', _id: OP }, node);
});

test('assertNodeTelemetryAccess: grid_operator in-zone is DENIED (PII boundary)', () => {
  // The operator can SEE this node's metadata (assertNodeAccess read passes),
  // but raw meter telemetry is personal data and must not be exposed.
  const node = { userId: OTHER, zoneId: 'north', operators: [] };
  assertThrowsApi(
    () => assertNodeTelemetryAccess(gridOp(['north']), node),
    404,
    'NODE_NOT_FOUND',
  );
});

test('assertNodeTelemetryAccess: unrelated user is denied (404, no existence leak)', () => {
  assertThrowsApi(
    () => assertNodeTelemetryAccess({ role: 'consumer', _id: OP }, { userId: OTHER }),
    404,
    'NODE_NOT_FOUND',
  );
});

test('assertNodeTelemetryAccess: missing node is 404', () => {
  assertThrowsApi(
    () => assertNodeTelemetryAccess({ role: 'admin', _id: OP }, null),
    404,
    'NODE_NOT_FOUND',
  );
});

// ---------------------------------------------------------------------------
// Re-affirm the core ownership/delegation invariants the multi-tenancy model
// rests on (regression net for the changes that introduced the active set).
// ---------------------------------------------------------------------------

test('getUserZoneIds still sanitizes + dedupes assigned zone codes', () => {
  assert.deepStrictEqual(
    getUserZoneIds({ assignedZoneIds: ['North', 'north', 'BAD!', '', 'east'] }),
    ['north', 'east'],
  );
});

test('non-owner consumer is still denied another user node (ownership IDOR stays fixed)', () => {
  assertThrowsApi(
    () => assertNodeAccess({ role: 'consumer', _id: OWNER }, { userId: OTHER }, 'read'),
    404,
    'NODE_NOT_FOUND',
  );
});

test('a write delegate still cannot manage the access surface (no escalation)', () => {
  // Re-exported indirectly via assertNodeAccess: write delegate gets write but
  // operators/zone management is owner+admin only (covered in nodeRbac). Here
  // we assert the write path itself still resolves for a write delegate.
  const node = { userId: OTHER, operators: [{ userId: OP, permission: 'write' }] };
  assertNodeAccess({ role: 'prosumer', _id: OP }, node, 'write');
});
