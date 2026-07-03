const EnergyNode = require('../models/EnergyNode');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const { isPrivileged } = require('../utils/nodeOwnership');
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

  if (isPrivileged(req.user)) {
    return doc;
  }

  const { userId, ...publicFields } = doc;
  return publicFields;
};

const createNode = asyncHandler(async (req, res) => {
  const safeBody = sanitizeNodePayload(req.body, { allowUserId: true });
  const { name, nodeType, sourceType, location, userId } = safeBody;

  if (!name || !nodeType || !sourceType || !userId) {
    throw new ApiError('Name, nodeType, sourceType, and userId are required', 400, 'INVALID_NODE_PAYLOAD');
  }

  const coordinates = normalizeCoordinates(req.body.coordinates);

  const node = await EnergyNode.create({
    name,
    nodeType,
    sourceType,
    location,
    userId,
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
  const filter = isPrivileged(req.user) ? {} : { userId: req.user._id };

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

  const node = await EnergyNode.findByIdAndUpdate(req.params.id, safeUpdates, {
    new: true,
    runValidators: true,
  });

  if (!node) {
    throw new ApiError('Node not found', 404, 'NODE_NOT_FOUND');
  }

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
