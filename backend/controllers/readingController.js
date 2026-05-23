const EnergyReading = require('../models/EnergyReading');

// @desc    Create a new reading
// @route   POST /api/v1/readings
// @access  Public
const createReading = async (req, res) => {
  try {
    const { nodeId, energyGenerated, energyConsumed } = req.body;

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        message: 'nodeId is required',
      });
    }

    const reading = await EnergyReading.create({
      nodeId,
      energyGenerated: energyGenerated || 0,
      energyConsumed: energyConsumed || 0,
    });

    // Emit the new reading to all connected socket clients
    const io = req.app.get('io');
    if (io) {
      io.emit('newReading', reading);
    }

    res.status(201).json({
      success: true,
      data: reading,
    });
  } catch (error) {
    console.error('Create reading error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error creating reading',
    });
  }
};

// @desc    Get all readings
// @route   GET /api/v1/readings
// @access  Public
const getReadings = async (req, res) => {
  try {
    // Optional filter by nodeId
    const query = {};
    if (req.query.nodeId) {
      query.nodeId = req.query.nodeId;
    }

    // Return the latest 100 readings for the query by default
    const readings = await EnergyReading.find(query).sort({ timestamp: -1 }).limit(100);

    res.status(200).json({
      success: true,
      count: readings.length,
      data: readings,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error fetching readings',
    });
  }
};

module.exports = { createReading, getReadings };
