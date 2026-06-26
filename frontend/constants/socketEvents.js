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
    // Order book (Sub-module 6.1.4)
    ORDERBOOK_UPDATE: 'orderbookUpdate',
  },
};
