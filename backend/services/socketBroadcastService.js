const analyticsService = require('./analyticsService');
const { SOCKET_EVENTS } = require('../socket/events');

let io = null;
let analyticsDebounceTimer = null;

const ANALYTICS_DEBOUNCE_MS = parseInt(
  process.env.SOCKET_ANALYTICS_DEBOUNCE_MS || '500',
  10,
);

const setIo = (socketIo) => {
  io = socketIo;
};

const emit = (event, payload) => {
  if (!io) return;
  io.emit(event, payload);
};

const emitNewReading = (reading) => {
  const payload = reading?.toObject ? reading.toObject() : reading;
  emit(SOCKET_EVENTS.SERVER.NEW_READING, payload);
};

const flushAnalytics = async () => {
  if (!io) return;
  try {
    const summary = await analyticsService.getSummary();
    emit(SOCKET_EVENTS.SERVER.ANALYTICS_UPDATE, summary);
  } catch (err) {
    console.error('Analytics broadcast failed:', err.message);
  }
};

const scheduleAnalyticsUpdate = () => {
  if (analyticsDebounceTimer) {
    clearTimeout(analyticsDebounceTimer);
  }
  analyticsDebounceTimer = setTimeout(() => {
    analyticsDebounceTimer = null;
    flushAnalytics();
  }, ANALYTICS_DEBOUNCE_MS);
};

const emitReadingAndAnalytics = async (reading) => {
  emitNewReading(reading);
  scheduleAnalyticsUpdate();
};

const emitBlockchainEvent = (eventPayload) => {
  emit(SOCKET_EVENTS.SERVER.BLOCKCHAIN_EVENT, eventPayload);
};

const emitBlockchainEventWithAnalytics = (eventPayload) => {
  emitBlockchainEvent(eventPayload);
  scheduleAnalyticsUpdate();
};

module.exports = {
  setIo,
  emitNewReading,
  flushAnalytics,
  scheduleAnalyticsUpdate,
  emitReadingAndAnalytics,
  emitBlockchainEvent,
  emitBlockchainEventWithAnalytics,
};
