const EnergyNode = require('../models/EnergyNode');

// @desc    Create a new node
// @route   POST /api/v1/nodes
// @access  Public (for now, eventually Private)
const createNode = async (req, res) => {
  try {
    // Note: userId should ideally come from req.user (auth middleware).
    // For now we allow it in body or we can hardcode a mock user for testing if omitted.
    const { name, nodeType, sourceType, location, userId } = req.body;

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
      data: node,
    });
  } catch (error) {
    console.error('Create node error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error creating node',
    });
  }
};

// @desc    Get all nodes
// @route   GET /api/v1/nodes
// @access  Public
const getNodes = async (req, res) => {
  try {
    const nodes = await EnergyNode.find();
    res.status(200).json({
      success: true,
      count: nodes.length,
      data: nodes,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error fetching nodes',
    });
  }
};

// @desc    Get node by ID
// @route   GET /api/v1/nodes/:id
// @access  Public
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
      data: node,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error fetching node',
    });
  }
};

// @desc    Update node
// @route   PUT /api/v1/nodes/:id
// @access  Public
const updateNode = async (req, res) => {
  try {
    const node = await EnergyNode.findByIdAndUpdate(req.params.id, req.body, {
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
      data: node,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error updating node',
    });
  }
};

// @desc    Delete node
// @route   DELETE /api/v1/nodes/:id
// @access  Public
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
