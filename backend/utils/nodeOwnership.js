const mongoose = require('mongoose');
const EnergyNode = require('../models/EnergyNode');
const ApiError = require('./apiError');
const { isPrivilegedRole, ROLES } = require('../auth/roles');

const isPrivileged = (user) => isPrivilegedRole(user?.role);

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
 * Mongo filter for list endpoints. Privileged roles see everything; everyone
 * else is scoped to their own nodes. Reused by controllers + the map service.
 */
function buildNodeListFilter(user) {
  if (isPrivileged(user)) return {};
  if (!user?._id) {
    throw new ApiError('Authentication required', 401, 'NOT_AUTHORIZED');
  }
  return { userId: user._id };
}

/**
 * Ownership/privilege access check for a loaded node document. Privileged roles
 * pass; the owner passes; everyone else is denied. Existence is reported as
 * 404 (not 403) so the endpoint does not leak the existence of another user's
 * node — a hardening over the previous NODE_ACCESS_DENIED 403.
 */
function assertNodeAccess(user, node) {
  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }
  if (isPrivileged(user)) return;
  if (!user?._id || String(node.userId) !== String(user._id)) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }
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

module.exports = {
  isPrivileged,
  allowedNodeTypesForRole,
  assertNodeTypeAllowedForRole,
  resolveCreateOwner,
  buildNodeListFilter,
  assertNodeAccess,
  getOwnedNodeIds,
  getOwnedNodes,
  assertNodeOwnership,
  assertNodesOwnership,
};
