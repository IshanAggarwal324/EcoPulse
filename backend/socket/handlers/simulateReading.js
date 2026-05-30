const mongoose = require('mongoose');
const EnergyReading = require('../../models/EnergyReading');
const socketBroadcastService = require('../../services/socketBroadcastService');
const { SOCKET_EVENTS } = require('../events');

const isSimulationAllowed = () =>
  process.env.ALLOW_SOCKET_SIMULATION === 'true'
  || process.env.NODE_ENV !== 'production';

const handleSimulateReading = async (data) => {
  if (!data?.nodeId) return;

  const reading = {
    nodeId: data.nodeId,
    energyGenerated: Number(data.energyGenerated) || 0,
    energyConsumed: Number(data.energyConsumed) || 0,
    timestamp: new Date().toISOString(),
  };

  if (mongoose.Types.ObjectId.isValid(data.nodeId)) {
    try {
      const saved = await EnergyReading.create({
        nodeId: data.nodeId,
        energyGenerated: reading.energyGenerated,
        energyConsumed: reading.energyConsumed,
      });
      await socketBroadcastService.emitReadingAndAnalytics(saved);
      return;
    } catch (err) {
      console.error('Socket reading persist failed:', err.message);
    }
  }

  socketBroadcastService.emitNewReading(reading);
};

const register = (socket) => {
  if (!isSimulationAllowed()) return;

  socket.on(SOCKET_EVENTS.CLIENT.SIMULATE_READING, (data) => {
    handleSimulateReading(data).catch((err) => {
      console.error('simulateReading handler error:', err.message);
    });
  });
};

module.exports = { register, isSimulationAllowed };
