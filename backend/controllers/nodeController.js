const EnergyNode = require('../models/EnergyNode');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const {
  isPrivileged,
  resolveCreateOwner,
  buildNodeAccessFilter,
  assertNodeAccess,
  assertCanManageNodeAccess,
  assertNodeTypeAllowedForRole,
  sanitizeZoneId,
  sanitizeOperators,
} = require('../utils/nodeOwnership');
const {
  MAX_MAP_NODES,
  normalizeCoordinates,
  buildMapFilter,
  coordinatesExistFilter,
  hasValidCoordinates,
  shapeMapNode,
} = require('../services/nodeMapService');

const ALLOWED_NODE_FIELDS = new Set(['name', 'nodeType', 'sourceType', 'status', 'location', 'userId']);

const sanitizeNodePayload = (payload = {}, { allowUserId = true } = {}) => {
  const safe = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_NODE_FIELDS.has(key)) continue;
    if (!allowUserId && key === 'userId') continue;
    safe[key] = value;
  }
  return safe;
};

const toNodeResponse = (node, req) => {
  const doc = node?.toObject ? node.toObject() : node;
  if (!doc) return doc;

  // Owner + privileged roles see the full document (incl. operators list).
  // Everyone else (delegates, zone-readers) gets a PII-stripped view: the
  // owner id and the operators roster are access-surface data, not telemetry.
  const isOwner = req.user && String(doc.userId) === String(req.user._id);
  if (isPrivileged(req.user) || isOwner) {
    return doc;
  }

  const { userId, operators, ...publicFields } = doc;
  return publicFields;
};

const createNode = asyncHandler(async (req, res) => {
  const safeBody = sanitizeNodePayload(req.body, { allowUserId: true });
  const { name, nodeType, sourceType, location } = safeBody;

  if (!name || !nodeType || !sourceType) {
    throw new ApiError('Name, nodeType, and sourceType are required', 400, 'INVALID_NODE_PAYLOAD');
  }

  // Module 8.2 — nodeType must be permitted for the caller's role (e.g. a
  // consumer cannot create a producer node).
  assertNodeTypeAllowedForRole(req.user?.role, nodeType);

  // Module 8.2 — ownership: privileged roles may target an arbitrary user;
  // every other role owns the node themselves and a request-supplied userId is
  // ignored (prevents createNode IDOR).
  const userId = resolveCreateOwner(req.user, safeBody.userId);
  if (!userId) {
    throw new ApiError('Could not resolve node owner', 400, 'INVALID_NODE_PAYLOAD');
  }

  const coordinates = normalizeCoordinates(req.body.coordinates);

  // Module 8.3 — the creator (or admin) IS the owner, so they may set the
  // node's zone and initial operators at create time.
  const zoneId = sanitizeZoneId(req.body.zoneId);
  const operators = sanitizeOperators(req.body.operators, userId);

  const node = await EnergyNode.create({
    name,
    nodeType,
    sourceType,
    location,
    userId,
    ...(zoneId ? { zoneId } : {}),
    ...(operators ? { operators } : {}),
    ...(coordinates ? { coordinates } : {}),
  });

  res.status(201).json({
    success: true,
    data: toNodeResponse(node, req),
  });
});

const getNodes = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const skip = (page - 1) * limit;
  // Module 8.3 — zone + delegation-aware scoping.
  const filter = buildNodeAccessFilter(req.user);

  const [nodes, total] = await Promise.all([
    EnergyNode.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    EnergyNode.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    count: nodes.length,
    total,
    pagination: {
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    },
    data: nodes.map((node) => toNodeResponse(node, req)),
  });
});

const getNodeById = asyncHandler(async (req, res) => {
  const node = await EnergyNode.findById(req.params.id);
  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }

  // Module 8.3 — enforce ownership/delegation/zone access (fixes GET /nodes/:id
  // IDOR and now grants read to delegates + zoned grid_operators).
  assertNodeAccess(req.user, node, 'read');

  res.status(200).json({
    success: true,
    data: toNodeResponse(node, req),
  });
});

const updateNode = asyncHandler(async (req, res) => {
  const safeUpdates = sanitizeNodePayload(req.body, { allowUserId: false });

  // Coordinates are validated/normalized explicitly (not via the allow-list).
  // normalizeCoordinates returns null when both fields are empty, which clears
  // the stored coordinates.
  if (req.body.coordinates !== undefined) {
    safeUpdates.coordinates = normalizeCoordinates(req.body.coordinates);
  }

  const node = await EnergyNode.findById(req.params.id);
  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }

  // Module 8.3 — enforce access BEFORE any content validation so a non-owner
  // cannot infer processing state from differing error codes. Write delegates
  // pass the 'write' check; read-only delegates/operators get a 403.
  assertNodeAccess(req.user, node, 'write');

  // A node-type change must still be permitted for the caller's role (e.g. a
  // consumer cannot upgrade a node to `producer`).
  if (safeUpdates.nodeType !== undefined) {
    assertNodeTypeAllowedForRole(req.user?.role, safeUpdates.nodeType);
  }

  // Module 8.3 — zone + operators are access-surface fields. Only the OWNER or
  // a privileged role may touch them (assertCanManageNodeAccess). This blocks a
  // write-delegate from escalating privileges (adding operators) or re-zoning.
  if (req.body.zoneId !== undefined || req.body.operators !== undefined) {
    assertCanManageNodeAccess(req.user, node);
    if (req.body.zoneId !== undefined) {
      safeUpdates.zoneId = sanitizeZoneId(req.body.zoneId);
    }
    if (req.body.operators !== undefined) {
      const ops = sanitizeOperators(req.body.operators, node.userId);
      safeUpdates.operators = Array.isArray(ops) ? ops : [];
    }
  }

  node.set(safeUpdates);
  await node.save();

  res.status(200).json({
    success: true,
    data: toNodeResponse(node, req),
  });
});

const deleteNode = asyncHandler(async (req, res) => {
  const node = await EnergyNode.findById(req.params.id);
  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }

  // Module 8.3 — only the owner (or privileged) may delete; delegates cannot.
  assertNodeAccess(req.user, node, 'write');
  assertCanManageNodeAccess(req.user, node);

  await node.deleteOne();
  res.status(200).json({
    success: true,
    data: {},
  });
});

// Module 9.5 — geographic map payload. RBAC-scoped (own nodes only unless
// privileged) and PII-free. Bounded by MAX_MAP_NODES to protect payload size.
const getNodesForMap = asyncHandler(async (req, res) => {
  const filter = { ...buildMapFilter(req.user), ...coordinatesExistFilter() };

  const nodes = await EnergyNode.aggregate([
    { $match: filter },
    { $sort: { createdAt: -1 } },
    { $limit: MAX_MAP_NODES },
    {
      $lookup: {
        from: 'energyreadings',
        let: { nodeId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$nodeId', '$$nodeId'] } } },
          { $sort: { timestamp: -1 } },
          { $limit: 1 },
          {
            $project: {
              _id: 0,
              energyGenerated: 1,
              energyConsumed: 1,
              timestamp: 1,
              unit: 1,
            },
          },
        ],
        as: 'lastReading',
      },
    },
    { $set: { lastReading: { $arrayElemAt: ['$lastReading', 0] } } },
  ]);

  const data = nodes.filter(hasValidCoordinates).map(shapeMapNode);

  res.status(200).json({
    success: true,
    count: data.length,
    data,
  });
});

module.exports = { createNode, getNodes, getNodeById, updateNode, deleteNode, getNodesForMap };
