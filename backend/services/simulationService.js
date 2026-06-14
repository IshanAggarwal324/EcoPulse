const readingService = require('./readingService');

const isSimulationAllowed = () => process.env.ALLOW_SOCKET_SIMULATION === 'true';

const ingestSimulatedReading = async (data) => {
  if (!isSimulationAllowed()) {
    const err = new Error('Socket simulation is disabled in this environment');
    err.statusCode = 403;
    throw err;
  }
  return readingService.ingestSimulatedReading(data);
};

module.exports = {
  isSimulationAllowed,
  ingestSimulatedReading,
};
