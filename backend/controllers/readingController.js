const EnergyReading = require('../models/EnergyReading');
const socketBroadcastService = require('../services/socketBroadcastService');
const asyncHandler = require('../utils/asyncHandler');

const emitReadingUpdate = async (reading) => {
  await socketBroadcastService.emitReadingAndAnalytics(reading);
};

const createReading = asyncHandler(async (req, res) => {
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

  await emitReadingUpdate(reading);

  res.status(201).json({
    success: true,
    data: reading,
  });
});

const getReadings = asyncHandler(async (req, res) => {
  const query = {};
  if (req.query.nodeId) {
    query.nodeId = req.query.nodeId;
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const readings = await EnergyReading.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .populate('nodeId', 'name nodeType sourceType status');

  res.status(200).json({
    success: true,
    count: readings.length,
    data: readings,
  });
});

module.exports = { createReading, getReadings, emitReadingUpdate };
