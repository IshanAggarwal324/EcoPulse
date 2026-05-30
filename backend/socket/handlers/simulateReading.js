const simulationService = require('../../services/simulationService');
const { SOCKET_EVENTS } = require('../events');

const register = (socket) => {
  if (!simulationService.isSimulationAllowed()) return;

  socket.on(SOCKET_EVENTS.CLIENT.SIMULATE_READING, (data) => {
    simulationService.ingestSimulatedReading(data).catch((err) => {
      console.error('simulateReading handler error:', err.message);
    });
  });
};

module.exports = { register };
