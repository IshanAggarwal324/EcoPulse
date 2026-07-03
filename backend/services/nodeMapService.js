const ApiError = require('../utils/apiError');
const { isPrivileged } = require('../utils/nodeOwnership');

// Module 9.5 — Live grid map. Pure helpers kept separate from the controller so
// the security-critical logic (RBAC scoping, coordinate validation, PII
// stripping) is unit-testable without a database.

const MAX_MAP_NODES = Math.max(1, parseInt(process.env.NODE_MAP_MAX_NODES || '500', 10));
const COORD_PRECISION = 6;
const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Parse a single raw coordinate value into a finite number within [min, max].
 * Empty input (null/undefined/'') returns null so callers can distinguish
 * "not provided" from an explicit value.
 */
function parseCoordinate(raw, { name, min, max }) {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = typeof raw === 'number' ? raw : Number(raw);
  // Reject NaN, Infinity, and objects/arrays that coerce to numbers silently.
  if (!Number.isFinite(num)) {
    throw new ApiError(`${name} must be a finite number`, 400, 'INVALID_COORDINATES');
  }
  if (num < min || num > max) {
    throw new ApiError(`${name} must be between ${min} and ${max}`, 400, 'INVALID_COORDINATES');
  }
  return num;
}

/**
 * Normalize a request { lat, lng } payload.
 * - Returns null when both are empty (update callers use this to clear).
 * - Rejects when exactly one is supplied (ambiguous / partial).
 * - Rounds to COORD_PRECISION to keep stored data tidy.
 */
function normalizeCoordinates(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError('coordinates must be an object with lat and lng', 400, 'INVALID_COORDINATES');
  }

  const lat = parseCoordinate(input.lat, { name: 'Latitude', min: LAT_MIN, max: LAT_MAX });
  const lng = parseCoordinate(input.lng, { name: 'Longitude', min: LNG_MIN, max: LNG_MAX });

  if (lat === null && lng === null) return null;
  if (lat === null || lng === null) {
    throw new ApiError('Both latitude and longitude are required', 400, 'INVALID_COORDINATES');
  }

  return {
    lat: Number(lat.toFixed(COORD_PRECISION)),
    lng: Number(lng.toFixed(COORD_PRECISION)),
  };
}

/**
 * RBAC scoping for the map view. A node's physical location is sensitive, so
 * non-privileged users may only ever map their OWN nodes. Admin/moderator see
 * all (intended for grid operators). This is the core privacy guardrail.
 */
function buildMapFilter(user) {
  if (isPrivileged(user)) return {};
  if (!user?._id) {
    throw new ApiError('Authentication required', 401, 'NOT_AUTHORIZED');
  }
  return { userId: user._id };
}

/**
 * DB-level predicate for "has valid, in-range coordinates". Combined with the
 * userId filter this keeps the map query bounded and cheap.
 */
function coordinatesExistFilter() {
  return {
    'coordinates.lat': { $ne: null, $gte: LAT_MIN, $lte: LAT_MAX },
    'coordinates.lng': { $ne: null, $gte: LNG_MIN, $lte: LNG_MAX },
  };
}

const hasValidCoordinates = (node) => {
  const c = node?.coordinates;
  return (
    isFiniteNumber(c?.lat)
    && isFiniteNumber(c?.lng)
    && c.lat >= LAT_MIN
    && c.lat <= LAT_MAX
    && c.lng >= LNG_MIN
    && c.lng <= LNG_MAX
  );
};

/**
 * Public map payload for a single node. Deliberately omits owner PII
 * (userId / email) — the map only needs identity-free operational fields.
 */
function shapeMapNode(node) {
  const last = node.lastReading || {};
  const c = node.coordinates || {};
  const ts = last.timestamp instanceof Date ? last.timestamp.toISOString() : last.timestamp || null;

  return {
    id: String(node._id),
    name: node.name,
    nodeType: node.nodeType,
    sourceType: node.sourceType,
    status: node.status,
    coordinates: {
      lat: Number(c.lat),
      lng: Number(c.lng),
    },
    lastReading: {
      energyGenerated: Number(last.energyGenerated) || 0,
      energyConsumed: Number(last.energyConsumed) || 0,
      timestamp: ts,
      unit: last.unit || 'kW',
    },
  };
}

module.exports = {
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
};
