const mongoose = require('mongoose');
const EnergyReading = require('../models/EnergyReading');
const EnergyNode = require('../models/EnergyNode');
const socketBroadcastService = require('./socketBroadcastService');

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const validateReadingInput = ({ nodeId, energyGenerated, energyConsumed }) => {
  if (!nodeId) {
    const err = new Error('nodeId is required');
    err.statusCode = 400;
    throw err;
  }

  return {
    nodeId,
    energyGenerated: Math.max(0, toNumber(energyGenerated)),
    energyConsumed: Math.max(0, toNumber(energyConsumed)),
  };
};

const createReading = async ({ nodeId, energyGenerated, energyConsumed }) => {
  const input = validateReadingInput({ nodeId, energyGenerated, energyConsumed });

  const reading = await EnergyReading.create({
    nodeId: input.nodeId,
    energyGenerated: input.energyGenerated,
    energyConsumed: input.energyConsumed,
  });

  await socketBroadcastService.emitReadingAndAnalytics(reading);
  return reading;
};

const listReadings = async ({ nodeId, limit = 100 } = {}) => {
  const query = {};
  if (nodeId) query.nodeId = nodeId;

  const cappedLimit = Math.min(parseInt(limit, 10) || 100, 500);

  return EnergyReading.find(query)
    .sort({ timestamp: -1 })
    .limit(cappedLimit)
    .populate('nodeId', 'name nodeType sourceType status');
};

/**
 * Socket simulator path: persist when nodeId is valid, else broadcast ephemeral reading.
 */
const ingestSimulatedReading = async (data) => {
  const input = validateReadingInput({
    nodeId: data?.nodeId,
    energyGenerated: data?.energyGenerated,
    energyConsumed: data?.energyConsumed,
  });

  if (mongoose.Types.ObjectId.isValid(input.nodeId)) {
    const nodeExists = await EnergyNode.exists({ _id: input.nodeId });
    if (nodeExists) {
      return createReading(input);
    }
  }

  const ephemeral = {
    ...input,
    timestamp: new Date().toISOString(),
  };
  socketBroadcastService.emitNewReading(ephemeral);
  return ephemeral;
};

module.exports = {
  createReading,
  listReadings,
  ingestSimulatedReading,
  validateReadingInput,
};
