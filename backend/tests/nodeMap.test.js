const { test } = require('node:test');
const assert = require('node:assert');

const {
  MAX_MAP_NODES,
  COORD_PRECISION,
  LAT_MIN,
  LAT_MAX,
  LNG_MIN,
  LNG_MAX,
  parseCoordinate,
  normalizeCoordinates,
  buildMapFilter,
  coordinatesExistFilter,
  hasValidCoordinates,
  shapeMapNode,
} = require('../services/nodeMapService');

const assertThrows = (fn, statusCode, code, label) => {
  try {
    fn();
    assert.fail(`Expected throw${label ? ` (${label})` : ''}`);
  } catch (err) {
    if (statusCode !== undefined) assert.strictEqual(err.statusCode, statusCode, `${label}: status`);
    if (code !== undefined) assert.strictEqual(err.code, code, `${label}: code`);
  }
};

// ---- parseCoordinate -------------------------------------------------------
test('parseCoordinate parses numbers and numeric strings', () => {
  assert.strictEqual(parseCoordinate(12.5, { name: 'Lat', min: -90, max: 90 }), 12.5);
  assert.strictEqual(parseCoordinate('12.5', { name: 'Lat', min: -90, max: 90 }), 12.5);
  assert.strictEqual(parseCoordinate('-5', { name: 'Lat', min: -90, max: 90 }), -5);
});

test('parseCoordinate returns null for empty input', () => {
  assert.strictEqual(parseCoordinate(null, { name: 'Lat', min: -90, max: 90 }), null);
  assert.strictEqual(parseCoordinate(undefined, { name: 'Lat', min: -90, max: 90 }), null);
  assert.strictEqual(parseCoordinate('', { name: 'Lat', min: -90, max: 90 }), null);
});

test('parseCoordinate rejects non-finite / junk with 400', () => {
  assertThrows(() => parseCoordinate('abc', { name: 'Lat', min: -90, max: 90 }), 400, 'INVALID_COORDINATES', 'abc');
  assertThrows(() => parseCoordinate(NaN, { name: 'Lat', min: -90, max: 90 }), 400, 'INVALID_COORDINATES', 'NaN');
  assertThrows(() => parseCoordinate(Infinity, { name: 'Lat', min: -90, max: 90 }), 400, 'INVALID_COORDINATES', 'Infinity');
});

test('parseCoordinate rejects out-of-range with 400', () => {
  assertThrows(() => parseCoordinate(91, { name: 'Lat', min: LAT_MIN, max: LAT_MAX }), 400, 'INVALID_COORDINATES', 'lat>90');
  assertThrows(() => parseCoordinate(-91, { name: 'Lat', min: LAT_MIN, max: LAT_MAX }), 400, 'INVALID_COORDINATES', 'lat<-90');
  assertThrows(() => parseCoordinate(181, { name: 'Lng', min: LNG_MIN, max: LNG_MAX }), 400, 'INVALID_COORDINATES', 'lng>180');
});

// ---- normalizeCoordinates --------------------------------------------------
test('normalizeCoordinates rounds to COORD_PRECISION', () => {
  const c = normalizeCoordinates({ lat: 12.3456789, lng: -98.7654321 });
  assert.strictEqual(c.lat, 12.345679);
  assert.strictEqual(c.lng, -98.765432);
  assert.strictEqual(MAX_MAP_NODES > 0, true);
  assert.strictEqual(COORD_PRECISION, 6);
});

test('normalizeCoordinates accepts boundary values', () => {
  const c = normalizeCoordinates({ lat: LAT_MAX, lng: LNG_MAX });
  assert.strictEqual(c.lat, LAT_MAX);
  assert.strictEqual(c.lng, LNG_MAX);
});

test('normalizeCoordinates returns null when both empty (clear intent)', () => {
  assert.strictEqual(normalizeCoordinates(null), null);
  assert.strictEqual(normalizeCoordinates(undefined), null);
  assert.strictEqual(normalizeCoordinates({}), null);
  assert.strictEqual(normalizeCoordinates({ lat: '', lng: '' }), null);
});

test('normalizeCoordinates rejects partial coordinates with 400', () => {
  assertThrows(() => normalizeCoordinates({ lat: 10 }), 400, 'INVALID_COORDINATES', 'lat only');
  assertThrows(() => normalizeCoordinates({ lng: 10 }), 400, 'INVALID_COORDINATES', 'lng only');
  assertThrows(() => normalizeCoordinates({ lat: 10, lng: '' }), 400, 'INVALID_COORDINATES', 'empty lng');
});

test('normalizeCoordinates rejects bad shapes with 400', () => {
  assertThrows(() => normalizeCoordinates([1, 2]), 400, 'INVALID_COORDINATES', 'array');
  assertThrows(() => normalizeCoordinates('12,34'), 400, 'INVALID_COORDINATES', 'string');
  assertThrows(() => normalizeCoordinates({ lat: 'x', lng: 5 }), 400, 'INVALID_COORDINATES', 'non-numeric lat');
  assertThrows(() => normalizeCoordinates({ lat: 5, lng: 999 }), 400, 'INVALID_COORDINATES', 'lng out of range');
});

// ---- buildMapFilter (RBAC privacy boundary) -------------------------------
test('buildMapFilter: admin sees all (empty filter)', () => {
  assert.deepStrictEqual(buildMapFilter({ role: 'admin', _id: 'u1' }), {});
});

test('buildMapFilter: moderator sees all', () => {
  assert.deepStrictEqual(buildMapFilter({ role: 'moderator', _id: 'u1' }), {});
});

test('buildMapFilter: regular user is scoped to own + delegated nodes', () => {
  // Module 8.3 — buildMapFilter now delegates to the zone/delegation-aware
  // access filter, so a user also maps nodes they are an operator on.
  const uid = '507f1f77bcf86cd799439011';
  assert.deepStrictEqual(buildMapFilter({ role: 'consumer', _id: uid }), {
    $or: [{ userId: uid }, { 'operators.userId': uid }],
  });
});

test('buildMapFilter: grid_operator without zones is scoped to own + delegated nodes', () => {
  const uid = '507f1f77bcf86cd799439011';
  assert.deepStrictEqual(buildMapFilter({ role: 'grid_operator', _id: uid }), {
    $or: [{ userId: uid }, { 'operators.userId': uid }],
  });
});

test('buildMapFilter: grid_operator with zones also maps their assigned zones', () => {
  const uid = '507f1f77bcf86cd799439011';
  assert.deepStrictEqual(
    buildMapFilter({ role: 'grid_operator', _id: uid, assignedZoneIds: ['north'] }),
    {
      $or: [
        { userId: uid },
        { 'operators.userId': uid },
        { zoneId: { $in: ['north'] } },
      ],
    },
  );
});

test('buildMapFilter: missing user throws 401', () => {
  assertThrows(() => buildMapFilter(null), 401, 'NOT_AUTHORIZED', 'null user');
  assertThrows(() => buildMapFilter({}), 401, 'NOT_AUTHORIZED', 'no _id');
});

// ---- coordinatesExistFilter ------------------------------------------------
test('coordinatesExistFilter requires both lat and lng in range', () => {
  const f = coordinatesExistFilter();
  assert.ok(f['coordinates.lat'].$ne === null);
  assert.ok(f['coordinates.lat'].$gte === LAT_MIN);
  assert.ok(f['coordinates.lat'].$lte === LAT_MAX);
  assert.ok(f['coordinates.lng'].$ne === null);
  assert.ok(f['coordinates.lng'].$gte === LNG_MIN);
  assert.ok(f['coordinates.lng'].$lte === LNG_MAX);
});

// ---- hasValidCoordinates ---------------------------------------------------
test('hasValidCoordinates truthy/falsy cases', () => {
  assert.strictEqual(hasValidCoordinates({ coordinates: { lat: 1, lng: 2 } }), true);
  assert.strictEqual(hasValidCoordinates({ coordinates: { lat: -90, lng: -180 } }), true);
  assert.strictEqual(hasValidCoordinates({}), false);
  assert.strictEqual(hasValidCoordinates({ coordinates: {} }), false);
  assert.strictEqual(hasValidCoordinates({ coordinates: { lat: 'x', lng: 2 } }), false);
  assert.strictEqual(hasValidCoordinates({ coordinates: { lat: 1 } }), false);
  assert.strictEqual(hasValidCoordinates({ coordinates: { lat: 91, lng: 2 } }), false);
});

// ---- shapeMapNode (PII stripping) -----------------------------------------
test('shapeMapNode omits owner PII and maps fields', () => {
  const node = {
    _id: 'n1',
    name: 'Solar A',
    nodeType: 'producer',
    sourceType: 'solar',
    status: 'active',
    userId: 'owner-id-secret',     // must NOT appear in output
    ownerEmail: 'secret@x.com',   // must NOT appear in output
    coordinates: { lat: 10, lng: 20 },
    lastReading: {
      energyGenerated: 5,
      energyConsumed: 1,
      timestamp: new Date('2026-01-01T00:00:00Z'),
      unit: 'kW',
    },
  };
  const out = shapeMapNode(node);
  assert.strictEqual(out.id, 'n1');
  assert.strictEqual(out.name, 'Solar A');
  assert.strictEqual(out.nodeType, 'producer');
  assert.strictEqual(out.status, 'active');
  assert.deepStrictEqual(out.coordinates, { lat: 10, lng: 20 });
  assert.strictEqual(out.lastReading.energyGenerated, 5);
  assert.strictEqual(out.lastReading.energyConsumed, 1);
  assert.strictEqual(out.lastReading.unit, 'kW');
  assert.strictEqual(out.lastReading.timestamp, '2026-01-01T00:00:00.000Z');

  // PII guards
  assert.strictEqual(out.userId, undefined, 'userId must be stripped');
  assert.strictEqual(out.ownerEmail, undefined, 'ownerEmail must be stripped');
  assert.strictEqual(JSON.stringify(out).includes('secret'), false, 'no secret leakage');
});

test('shapeMapNode defaults lastReading when absent', () => {
  const out = shapeMapNode({ _id: 'n2', name: 'B', nodeType: 'consumer', sourceType: 'home', status: 'failed', coordinates: { lat: 0, lng: 0 } });
  assert.strictEqual(out.lastReading.energyGenerated, 0);
  assert.strictEqual(out.lastReading.energyConsumed, 0);
  assert.strictEqual(out.lastReading.unit, 'kW');
  assert.strictEqual(out.lastReading.timestamp, null);
});

test('shapeMapNode coerces numeric strings in lastReading safely', () => {
  const out = shapeMapNode({
    _id: 'n3',
    name: 'C',
    nodeType: 'prosumer',
    sourceType: 'wind',
    status: 'active',
    coordinates: { lat: 1, lng: 1 },
    lastReading: { energyGenerated: '7.5', energyConsumed: 'bad', unit: 'MW' },
  });
  assert.strictEqual(out.lastReading.energyGenerated, 7.5);
  assert.strictEqual(out.lastReading.energyConsumed, 0);
  assert.strictEqual(out.lastReading.unit, 'MW');
});
