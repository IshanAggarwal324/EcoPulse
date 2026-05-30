/** Canonical Socket.io event names (server ↔ client). */
const SOCKET_EVENTS = {
  CLIENT: {
    SIMULATE_READING: 'simulateReading',
  },
  SERVER: {
    NEW_READING: 'newReading',
    ANALYTICS_UPDATE: 'analyticsUpdate',
    BLOCKCHAIN_EVENT: 'blockchainEvent',
  },
};

module.exports = { SOCKET_EVENTS };
