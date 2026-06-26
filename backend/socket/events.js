/** Canonical Socket.io event names (server ↔ client). */
const SOCKET_EVENTS = {
  CLIENT: {
    SIMULATE_READING: 'simulateReading',
  },
  SERVER: {
    NEW_READING: 'newReading',
    ANALYTICS_UPDATE: 'analyticsUpdate',
    BLOCKCHAIN_EVENT: 'blockchainEvent',
    NOTIFICATION: 'notification',
    SETTLEMENT_VERIFIED: 'settlementVerified',
    SETTLEMENT_MISMATCH: 'settlementMismatch',
    // Order book (Sub-module 6.1.4) — compact "book changed" push, not a full
    // resync. Clients refetch their visible page on receipt.
    ORDERBOOK_UPDATE: 'orderbookUpdate',
  },
};

module.exports = { SOCKET_EVENTS };
