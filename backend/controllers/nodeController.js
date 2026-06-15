const EnergyNode = require('../models/EnergyNode');

const ALLOWED_NODE_FIELDS = new Set(['name', 'nodeType', 'sourceType', 'status', 'location', 'userId']);

const isPrivileged = (user) => user?.role === 'admin' || user?.role === 'moderator';

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

const createNode = async (req, res) => {
  try {
    const safeBody = sanitizeNodePayload(req.body, { allowUserId: true });
    const { name, nodeType, sourceType, location, userId } = safeBody;

    if (!name || !nodeType || !sourceType || !userId) {
      return res.status(400).json({
        success: false,
        message: 'Name, nodeType, sourceType, and userId are required',
      });
    }

    const node = await EnergyNode.create({
      name,
      nodeType,
      sourceType,
      location,
      userId,
    });

    res.status(201).json({
      success: true,
      data: toNodeResponse(node, req),
    });
  } catch (error) {
    console.error('Create node error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error creating node',
    });
  }
};

const getNodes = async (req, res) => {
  try {
    const nodes = await EnergyNode.find();
    res.status(200).json({
      success: true,
      count: nodes.length,
      data: nodes.map((node) => toNodeResponse(node, req)),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error fetching nodes',
    });
  }
};

const getNodeById = async (req, res) => {
  try {
    const node = await EnergyNode.findById(req.params.id);
    if (!node) {
      return res.status(404).json({
        success: false,
        message: 'Node not found',
      });
    }
    res.status(200).json({
      success: true,
      data: toNodeResponse(node, req),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error fetching node',
    });
  }
};

const updateNode = async (req, res) => {
  try {
    const safeUpdates = sanitizeNodePayload(req.body, { allowUserId: false });
    const node = await EnergyNode.findByIdAndUpdate(req.params.id, safeUpdates, {
      new: true,
      runValidators: true,
    });
    if (!node) {
      return res.status(404).json({
        success: false,
        message: 'Node not found',
      });
    }
    res.status(200).json({
      success: true,
      data: toNodeResponse(node, req),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error updating node',
    });
  }
};

const deleteNode = async (req, res) => {
  try {
    const node = await EnergyNode.findById(req.params.id);
    if (!node) {
      return res.status(404).json({
        success: false,
        message: 'Node not found',
      });
    }
    await node.deleteOne();
    res.status(200).json({
      success: true,
      data: {},
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error deleting node',
    });
  }
};

module.exports = { createNode, getNodes, getNodeById, updateNode, deleteNode };
