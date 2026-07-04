const mongoose = require('mongoose');
const EnergyNode = require('../models/EnergyNode');
const GridZone = require('../models/GridZone');
const ApiError = require('./apiError');
const { logger } = require('./logger');
const { isPrivilegedRole, ROLES } = require('../auth/roles');

const isPrivileged = (user) => isPrivilegedRole(user?.role);

// Module 8.3 — operator delegation + zone scoping limits.
const MAX_OPERATORS = 10;
const ZONE_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// Module 8.5 — active-zone visibility cache. A grid_operator's read scope is
// the intersection of their declared `assignedZoneIds` and the zones that are
// currently `active` in the GridZone collection. Resolving that on every node
// read would add a DB round-trip per request, so the active-code set is cached
// for a short TTL. The cache is invalidated by the admin zone controller on any
// create/update/delete so a deactivated/deleted zone revokes visibility within
// the same request rather than waiting for the TTL.
const ACTIVE_ZONE_TTL_MS = Math.max(
  1000,
  parseInt(process.env.ZONE_ACTIVE_CACHE_MS || '30000', 10),
);
let _activeZoneCache = { codes: null, expiresAt: 0 };

/**
 * Module 8.5 — the set of currently-active zone codes (lowercased). Cached for
 * ACTIVE_ZONE_TTL_MS. On any DB/lookup error the function FAILS CLOSED: it
 * resolves to an empty set so a grid_operator can never gain zone visibility
 * through an outage (they still see their own + delegated nodes). The empty
 * result is cached briefly to avoid hammering a failing collection.
 *
 * @returns {Promise<Set<string>>}
 */
async function getActiveZoneCodes() {
  const now = Date.now();
  if (_activeZoneCache.codes && _activeZoneCache.expiresAt > now) {
    return _activeZoneCache.codes;
  }

  let codes = new Set();
  try {
    const zones = await GridZone.find({ active: true }).select('code').lean();
    for (const z of zones) {
      const c = typeof z.code === 'string' ? z.code.toLowerCase() : null;
      if (c) codes.add(c);
    }
  } catch (err) {
    // Fail-closed: no active zones verifiable -> no zone visibility granted.
    logger.warn('grid_zone_active_lookup_failed', {
      error: err?.message || String(err),
    });
    codes = new Set();
  }

  _activeZoneCache = { codes, expiresAt: now + ACTIVE_ZONE_TTL_MS };
  return codes;
}

/**
 * Drop the active-zone cache. Called by the admin zone controller after any
 * create/update/delete so revocation is immediate instead of TTL-bound.
 */
function invalidateActiveZoneCache() {
  _activeZoneCache = { codes: null, expiresAt: 0 };
}

/**
 * Module 8.5 — resolve the active-zone context for a request. Returns the
 * cached active-code Set for grid_operator users (the only role whose node
 * visibility depends on zone state) and `undefined` for everyone else, so the
 * sync access core can short-circuit the zone intersection work.
 */
async function resolveActiveZoneCodes(user) {
  if (user?.role !== ROLES.GRID_OPERATOR) return undefined;
  return getActiveZoneCodes();
}

/**
 * Module 8.2 — which node types a role is allowed to create.
 * `null` means "any" (admin/moderator). An empty array means "none"
 * (grid_operator does not create nodes). Unknown roles resolve to none
 * (fail-closed).
 *
 * nodeType is intentionally decoupled from the user role: a `prosumer` may own
 * producer/consumer/prosumer nodes, a `consumer` only consumer nodes, etc.
 */
const ROLE_ALLOWED_NODE_TYPES = {
  [ROLES.CONSUMER]: ['consumer'],
  [ROLES.PROSUMER]: ['producer', 'consumer', 'prosumer'],
  [ROLES.GRID_OPERATOR]: [],
  [ROLES.ADMIN]: null,
  [ROLES.MODERATOR]: null,
};

/**
 * @returns {string[]|null} allowed node types, or `null` for "any".
 */
function allowedNodeTypesForRole(role) {
  const allowed = ROLE_ALLOWED_NODE_TYPES[role];
  if (allowed === undefined) return [];
  return allowed;
}

/**
 * Throws ApiError(403) if the role may not create a node of `nodeType`.
 */
function assertNodeTypeAllowedForRole(role, nodeType) {
  const allowed = allowedNodeTypesForRole(role);
  if (allowed === null) return;
  if (!nodeType || !allowed.includes(nodeType)) {
    throw new ApiError(
      `Your role is not permitted to create a "${nodeType}" node`,
      403,
      'NODE_TYPE_NOT_ALLOWED',
    );
  }
}

/**
 * Resolve the owner for a node-create operation.
 * Admins/moderators may create a node on behalf of any user (explicit
 * `requestedUserId`); every other role always owns the node themselves and the
 * request-supplied userId is ignored (prevents createNode IDOR).
 */
function resolveCreateOwner(user, requestedUserId) {
  if (isPrivileged(user)) {
    if (requestedUserId && mongoose.isValidObjectId(requestedUserId)) {
      return String(requestedUserId);
    }
    return user?._id ? String(user._id) : null;
  }
  return user?._id ? String(user._id) : null;
}

/**
 * Module 8.3 — the zone codes a grid_operator is responsible for. Returns [] for
 * any other role or a user without assignments. Inputs are coerced defensively
 * (deduped, validated) so a stray malformed code can never reach a Mongo filter.
 */
function getUserZoneIds(user) {
  const raw = Array.isArray(user?.assignedZoneIds) ? user.assignedZoneIds : [];
  const seen = new Set();
  const out = [];
  for (const code of raw) {
    if (typeof code !== 'string') continue;
    const c = code.trim().toLowerCase();
    if (!c || !ZONE_CODE_RE.test(c) || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Mongo predicate for "this user is an operator on the node with at least
 * `permission`". Read accepts read OR write; write requires write explicitly.
 */
function operatorMatchFilter(user, permission) {
  const uid = user?._id;
  if (!uid) return null;
  if (permission === 'write') {
    return { operators: { $elemMatch: { userId: uid, permission: 'write' } } };
  }
  return { 'operators.userId': uid };
}

/**
 * Module 8.3 — zone + delegation-aware list filter (the plan's `buildNodeQuery`).
 *
 * Visibility for a non-privileged user is the union of:
 *   - nodes they OWN                       ({ userId })
 *   - nodes they are DELEGATED on          (operatorMatchFilter)
 *   - (grid_operator only, read only) nodes in their assigned zone(s)
 *
 * Privileged roles (admin/moderator) see everything. grid_operator never gets a
 * zone clause for write permission — zone access is strictly read-only.
 */
function buildNodeAccessFilter(user, { permission = 'read', activeZoneCodes } = {}) {
  if (isPrivileged(user)) return {};
  if (!user?._id) {
    throw new ApiError('Authentication required', 401, 'NOT_AUTHORIZED');
  }

  const clauses = [{ userId: user._id }];

  const opClause = operatorMatchFilter(user, permission);
  if (opClause) clauses.push(opClause);

  if (user.role === ROLES.GRID_OPERATOR && permission === 'read') {
    let zones = getUserZoneIds(user);
    // Module 8.5 — intersect with the active zone set when provided. A zone
    // that has been deactivated (active:false) or deleted must immediately stop
    // granting visibility; without this an operator retains stale read access
    // until their assignment is manually edited. `activeZoneCodes` is supplied
    // by the async orchestrators (resolveActiveZoneCodes); when absent the core
    // trusts the user's declared zones (unit-test path).
    if (activeZoneCodes instanceof Set) {
      zones = zones.filter((z) => activeZoneCodes.has(z));
    }
    if (zones.length) clauses.push({ zoneId: { $in: zones } });
  }

  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

/**
 * Module 8.5 — async variant of buildNodeAccessFilter that resolves the
 * active-zone set (cached) before delegating to the sync core. Controllers
 * SHOULD use this so deactivation revokes grid_operator visibility without a
 * manual assignment edit.
 */
async function buildNodeAccessFilterAsync(user, opts = {}) {
  const activeZoneCodes = await resolveActiveZoneCodes(user);
  return buildNodeAccessFilter(user, { ...opts, activeZoneCodes });
}

/**
 * Backward-compatible alias used by nodeController + nodeMapService. Equivalent
 * to a read-scope access filter.
 */
function buildNodeListFilter(user) {
  return buildNodeAccessFilter(user, { permission: 'read' });
}

/**
 * Does the operator list grant `permission` to `userId`? Pure check on a loaded
 * node document (no DB hit). Read accepts read|write; write requires write.
 */
function nodeGrantsOperatorPermission(node, userId, permission) {
  const ops = Array.isArray(node?.operators) ? node.operators : [];
  if (!userId || ops.length === 0) return false;
  const uid = String(userId);
  return ops.some((op) => {
    if (!op || String(op.userId) !== uid) return false;
    if (permission === 'write') return op.permission === 'write';
    return op.permission === 'read' || op.permission === 'write';
  });
}

/**
 * Module 8.3 — ownership/privilege/delegation/zone access check for a LOADED
 * node document. Callers that only have a nodeId should use assertNodeOwnership.
 *
 * Access is granted when the caller is, in order:
 *   1. privileged (admin/moderator), OR
 *   2. the node owner, OR
 *   3. a delegate with sufficient permission, OR
 *   4. a grid_operator reading a node in one of their assigned zones (read only)
 *
 * Existence is reported as 404 (not 403) so the endpoint does not leak the
 * existence of another user's node. The only 403 is a write attempt by a
 * read-only delegate/operator, which is a clear policy violation worth surfacing
 * distinctly once access to the node is already established.
 */
function assertNodeAccess(user, node, permission = 'read', { activeZoneCodes } = {}) {
  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }
  if (permission !== 'read' && permission !== 'write') {
    throw new ApiError('Invalid permission', 400, 'INVALID_PERMISSION');
  }
  if (isPrivileged(user)) return;

  const uid = user?._id ? String(user._id) : null;

  // Owner has full access.
  if (uid && String(node.userId) === uid) return;

  // Delegated operator.
  if (uid && nodeGrantsOperatorPermission(node, uid, permission)) return;

  // grid_operator read-only zone visibility.
  if (
    permission === 'read'
    && user?.role === ROLES.GRID_OPERATOR
    && typeof node.zoneId === 'string'
    && node.zoneId
  ) {
    // Module 8.5 — zone visibility only counts while the zone is active. When
    // an active set is supplied (async path), a deactivated/deleted zone no
    // longer grants read even though it is still listed in assignedZoneIds.
    let zones = getUserZoneIds(user);
    if (activeZoneCodes instanceof Set) {
      zones = zones.filter((z) => activeZoneCodes.has(z));
    }
    if (zones.includes(node.zoneId.toLowerCase())) {
      return;
    }
  }

  // Distinguish "you can see it but not mutate it" (403) from "hidden" (404):
  // a read-only delegate/operator attempting a write clearly knows the node
  // exists, so 403 is appropriate. Everyone else gets a 404 (no existence leak).
  if (permission === 'write' && uid && nodeGrantsOperatorPermission(node, uid, 'read')) {
    throw new ApiError('You have read-only access to this node', 403, 'NODE_ACCESS_DENIED');
  }

  throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
}

/**
 * Module 8.5 — async variant of assertNodeAccess that resolves the active-zone
 * set (cached) before delegating. Controllers SHOULD use this for the GET/PUT/
 * DELETE node paths so a deactivated zone revokes a grid_operator's read.
 */
async function assertNodeAccessAsync(user, node, permission = 'read', opts = {}) {
  const activeZoneCodes = await resolveActiveZoneCodes(user);
  return assertNodeAccess(user, node, permission, { ...opts, activeZoneCodes });
}

/**
 * Module 8.5 — PII boundary for raw per-node meter telemetry (EnergyReading).
 *
 * Raw meter readings are personal energy-usage data. Access is granted to:
 *   - privileged roles (admin/moderator),
 *   - the node owner, and
 *   - a delegated operator with at least read permission.
 * It is DELIBERATELY NOT granted to a grid_operator via zone visibility: an
 * operator's scope is topology + aggregates, never an individual's meter curve.
 * Existence is hidden as 404 (no cross-tenant leak), matching assertNodeAccess.
 */
function assertNodeTelemetryAccess(user, node) {
  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }
  if (isPrivileged(user)) return;
  const uid = user?._id ? String(user._id) : null;
  if (uid && String(node.userId) === uid) return;
  if (uid && nodeGrantsOperatorPermission(node, uid, 'read')) return;
  throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
}

/**
 * Module 8.5 — load a node by id and enforce the telemetry PII boundary. Selects
 * only the fields needed for the access decision. Replaces the raw
 * assertNodeOwnership call on the readings path so delegated operators can read
 * a delegated node's meter data while grid_operator zone readers still cannot.
 */
async function assertNodeTelemetryAccessById(user, nodeId) {
  if (!nodeId || !mongoose.isValidObjectId(nodeId)) {
    throw new ApiError('A valid nodeId is required', 400, 'INVALID_NODE_ID');
  }
  const node = await EnergyNode.findById(nodeId).select('userId operators').lean();
  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }
  assertNodeTelemetryAccess(user, node);
  return node;
}

/**
 * Module 8.3 — ONLY the owner (or a privileged role) may manage a node's access
 * surface: the operators list and the zone assignment. Write-delegates can edit
 * node telemetry/fields but must NEVER be able to escalate privileges (add
 * operators) or re-zone the node. Throws on denial.
 */
function assertCanManageNodeAccess(user, node) {
  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }
  if (isPrivileged(user)) return;
  const uid = user?._id ? String(user._id) : null;
  if (uid && String(node.userId) === uid) return;
  // Existence hidden for non-owners to avoid leaking access surface state.
  throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
}

async function getOwnedNodeIds(userId) {
  if (!userId) return [];
  const nodes = await EnergyNode.find({ userId }).select('_id').lean();
  return nodes.map((n) => n._id.toString());
}

async function getOwnedNodes(userId) {
  if (!userId) return [];
  return EnergyNode.find({ userId }).select('_id name nodeType sourceType status').lean();
}

async function assertNodeOwnership(userId, nodeId) {
  if (!nodeId || !mongoose.isValidObjectId(nodeId)) {
    throw new ApiError('A valid nodeId is required', 400, 'INVALID_NODE_ID');
  }

  const node = await EnergyNode.findById(nodeId).select('userId').lean();
  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }

  if (String(node.userId) !== String(userId)) {
    throw new ApiError('You do not have access to this node', 403, 'NODE_ACCESS_DENIED');
  }

  return node;
}

async function assertNodesOwnership(userId, nodeIds) {
  if (!nodeIds.length) {
    throw new ApiError('At least one nodeId is required', 400, 'INVALID_NODE_IDS');
  }

  const unique = [...new Set(nodeIds)];
  for (const id of unique) {
    if (!mongoose.isValidObjectId(id)) {
      throw new ApiError('One or more node IDs are invalid', 400, 'INVALID_NODE_ID');
    }
  }

  const nodes = await EnergyNode.find({ _id: { $in: unique } }).select('_id userId').lean();
  const nodeMap = new Map(nodes.map((n) => [n._id.toString(), n]));

  const missing = unique.filter((id) => !nodeMap.has(id));
  if (missing.length > 0) {
    throw new ApiError('One or more nodes not found', 404, 'NODE_NOT_FOUND', { missingNodeIds: missing });
  }

  const denied = unique.filter((id) => String(nodeMap.get(id).userId) !== String(userId));
  if (denied.length > 0) {
    throw new ApiError(
      'You do not have access to one or more nodes',
      403,
      'NODE_ACCESS_DENIED',
      { deniedNodeIds: denied },
    );
  }

  return unique;
}

/**
 * Module 8.3 — validate a `zoneId` payload. Returns the lowercased code, `null`
 * to clear, or throws 400 on a malformed value. Empty string == clear.
 */
function sanitizeZoneId(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'string') {
    throw new ApiError('zoneId must be a string', 400, 'INVALID_ZONE');
  }
  const code = input.trim().toLowerCase();
  if (!code) return null;
  if (!ZONE_CODE_RE.test(code)) {
    throw new ApiError(
      'zoneId must be 1-64 chars of [a-z0-9_-], starting alphanumeric',
      400,
      'INVALID_ZONE',
    );
  }
  return code;
}

/**
 * Module 8.3 — validate + normalize an operators payload from an owner/admin.
 *
 * Accepts [{ userId, permission }] (or { userId, permission }). Rejects junk,
 * dedupes by userId, drops the owner (redundant), caps length, and coerces each
 * userId to an ObjectId. Returns `null` when the field is absent (so callers can
 * distinguish "not provided" from "explicitly cleared to []").
 */
function sanitizeOperators(input, ownerId) {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) {
    // Allow a single object for convenience; otherwise reject.
    if (input && typeof input === 'object') input = [input];
    else throw new ApiError('operators must be an array', 400, 'INVALID_OPERATORS');
  }

  const ownerIdStr = ownerId ? String(ownerId) : null;
  const seen = new Set();
  const out = [];

  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ApiError('Each operator must be an object', 400, 'INVALID_OPERATORS');
    }
    const uid = typeof entry.userId === 'string' ? entry.userId.trim() : entry.userId;
    if (!uid || !mongoose.isValidObjectId(uid)) {
      throw new ApiError('operator.userId must be a valid id', 400, 'INVALID_OPERATORS');
    }
    const permission = typeof entry.permission === 'string' ? entry.permission : 'read';
    if (!['read', 'write'].includes(permission)) {
      throw new ApiError('operator.permission must be "read" or "write"', 400, 'INVALID_OPERATORS');
    }
    const uidStr = String(uid);
    // Owner is implicitly the owner; never store them as an operator.
    if (ownerIdStr && uidStr === ownerIdStr) continue;
    if (seen.has(uidStr)) continue;
    seen.add(uidStr);
    out.push({ userId: new mongoose.Types.ObjectId(uidStr), permission });
  }

  if (out.length > MAX_OPERATORS) {
    throw new ApiError(`A node may have at most ${MAX_OPERATORS} operators`, 400, 'INVALID_OPERATORS');
  }

  return out;
}

module.exports = {
  isPrivileged,
  allowedNodeTypesForRole,
  assertNodeTypeAllowedForRole,
  resolveCreateOwner,
  getUserZoneIds,
  getActiveZoneCodes,
  invalidateActiveZoneCache,
  resolveActiveZoneCodes,
  buildNodeAccessFilter,
  buildNodeAccessFilterAsync,
  buildNodeListFilter,
  assertNodeAccess,
  assertNodeAccessAsync,
  assertNodeTelemetryAccess,
  assertNodeTelemetryAccessById,
  assertCanManageNodeAccess,
  nodeGrantsOperatorPermission,
  sanitizeZoneId,
  sanitizeOperators,
  getOwnedNodeIds,
  getOwnedNodes,
  assertNodeOwnership,
  assertNodesOwnership,
  MAX_OPERATORS,
  ACTIVE_ZONE_TTL_MS,
  __setActiveZoneCacheForTest: (codes) => {
    const set = codes instanceof Set
      ? codes
      : new Set(Array.isArray(codes) ? codes : []);
    _activeZoneCache = { codes: set, expiresAt: Date.now() + ACTIVE_ZONE_TTL_MS };
  },
};
