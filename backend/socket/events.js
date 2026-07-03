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
    // Module 9.4 — compact, anonymized live-trade push for the ticker. Fired
    // only from the realtime event listener (never from historical backfill),
    // so clients never receive a burst of stale trades on startup.
    TRADE_EXECUTED: 'tradeExecuted',
  },
};

module.exports = { SOCKET_EVENTS };
