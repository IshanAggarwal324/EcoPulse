const mongoose = require('mongoose');
const EnergyNode = require('../models/EnergyNode');
const ApiError = require('./apiError');

const isPrivileged = (user) => user?.role === 'admin' || user?.role === 'moderator';

async function getOwnedNodeIds(userId) {
  if (!userId) return [];
  const nodes = await EnergyNode.find({ userId }).select('_id').lean();
  return nodes.map((n) => n._id.toString());
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
  getOwnedNodeIds,
  assertNodeOwnership,
  assertNodesOwnership,
};
