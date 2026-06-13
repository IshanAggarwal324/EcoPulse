const mongoose = require('mongoose');
const EnergyNode = require('../../models/EnergyNode');
const EnergyReading = require('../../models/EnergyReading');
const { parsePagination, paginateResults } = require('../../utils/paginate');
const asyncHandler = require('../../utils/asyncHandler');
const auditService = require('../../services/auditService');

const VALID_NODE_TYPES = ['producer', 'consumer', 'prosumer'];
const VALID_SOURCE_TYPES = ['solar', 'wind', 'home', 'industry', 'other'];
const VALID_STATUSES = ['active', 'inactive', 'maintenance', 'failed'];

const listNodes = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { status, sourceType, nodeType } = req.query;

  const filter = {};

  if (status && VALID_STATUSES.includes(status)) {
    filter.status = status;
  }

  if (sourceType && VALID_SOURCE_TYPES.includes(sourceType)) {
    filter.sourceType = sourceType;
  }

  if (nodeType && VALID_NODE_TYPES.includes(nodeType)) {
    filter.nodeType = nodeType;
  }

  const [nodes, total] = await Promise.all([
    EnergyNode.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'owner',
        },
      },
      {
        $addFields: {
          ownerEmail: { $arrayElemAt: ['$owner.email', 0] },
          ownerName: { $arrayElemAt: ['$owner.name', 0] },
        },
      },
      { $project: { owner: 0 } },
    ]),
    EnergyNode.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: nodes,
    meta: paginateResults({ page, limit, total }),
  });
});

const createNode = asyncHandler(async (req, res) => {
  const { name, nodeType, sourceType, status, location, userId } = req.body;

  if (!name || !nodeType || !sourceType) {
    return res.status(400).json({
      success: false,
      message: 'Name, nodeType, and sourceType are required',
    });
  }

  if (!VALID_NODE_TYPES.includes(nodeType)) {
    return res.status(400).json({ success: false, message: `nodeType must be one of: ${VALID_NODE_TYPES.join(', ')}` });
  }

  if (!VALID_SOURCE_TYPES.includes(sourceType)) {
    return res.status(400).json({ success: false, message: `sourceType must be one of: ${VALID_SOURCE_TYPES.join(', ')}` });
  }

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const owner = userId || req.user._id;

  if (!mongoose.Types.ObjectId.isValid(owner)) {
    return res.status(400).json({ success: false, message: 'Invalid userId' });
  }

  const node = await EnergyNode.create({
    name,
    nodeType,
    sourceType,
    status: status || 'active',
    location,
    userId: owner,
  });

  await auditService.log({
    actor: req.user,
    action: 'NODE_CREATED',
    resourceType: 'node',
    resourceId: node._id,
    metadata: { name, nodeType, sourceType, status: status || 'active', userId: owner },
    req,
  });

  res.status(201).json({
    success: true,
    data: node,
  });
});

const updateNode = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid node ID' });
  }

  const allowedFields = ['name', 'nodeType', 'sourceType', 'status', 'location'];
  const updates = {};

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (updates.nodeType && !VALID_NODE_TYPES.includes(updates.nodeType)) {
    return res.status(400).json({ success: false, message: `nodeType must be one of: ${VALID_NODE_TYPES.join(', ')}` });
  }

  if (updates.sourceType && !VALID_SOURCE_TYPES.includes(updates.sourceType)) {
    return res.status(400).json({ success: false, message: `sourceType must be one of: ${VALID_SOURCE_TYPES.join(', ')}` });
  }

  if (updates.status && !VALID_STATUSES.includes(updates.status)) {
    return res.status(400).json({ success: false, message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const node = await EnergyNode.findByIdAndUpdate(id, updates, {
    new: true,
    runValidators: true,
  });

  if (!node) {
    return res.status(404).json({ success: false, message: 'Node not found' });
  }

  await auditService.log({
    actor: req.user,
    action: 'NODE_UPDATED',
    resourceType: 'node',
    resourceId: id,
    metadata: { updates, nodeName: node.name },
    req,
  });

  res.status(200).json({
    success: true,
    data: node,
  });
});

const deleteNode = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { cascade } = req.query;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid node ID' });
  }

  const node = await EnergyNode.findById(id);
  if (!node) {
    return res.status(404).json({ success: false, message: 'Node not found' });
  }

  if (cascade === 'true') {
    await EnergyReading.deleteMany({ nodeId: id });
  }

  await node.deleteOne();

  await auditService.log({
    actor: req.user,
    action: 'NODE_DELETED',
    resourceType: 'node',
    resourceId: id,
    metadata: { nodeName: node.name, cascade: cascade === 'true' },
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    data: {},
    meta: { cascade: cascade === 'true', nodeId: id },
  });
});

module.exports = {
  listNodes,
  createNode,
  updateNode,
  deleteNode,
};
