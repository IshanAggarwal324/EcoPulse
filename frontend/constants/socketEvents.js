/** Must stay in sync with backend/socket/events.js */
export const SOCKET_EVENTS = {
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
    // Order book (Sub-module 6.1.4)
    ORDERBOOK_UPDATE: 'orderbookUpdate',
    // Module 9.4 — compact, anonymized live trade for the ticker.
    TRADE_EXECUTED: 'tradeExecuted',
  },
};
