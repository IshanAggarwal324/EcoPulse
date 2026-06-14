const analyticsService = require('./analytics');
const { SOCKET_EVENTS } = require('../socket/events');

let io = null;
let analyticsDebounceTimer = null;
let pendingAnalyticsScope = 'realtime';

const ANALYTICS_DEBOUNCE_MS = parseInt(
  process.env.SOCKET_ANALYTICS_DEBOUNCE_MS || '750',
  10,
);

const setIo = (socketIo) => {
  io = socketIo;
};

const emit = (event, payload) => {
  if (!io) return;
  io.to('authenticated').emit(event, payload);
};

const emitNewReading = (reading) => {
  const payload = reading?.toObject ? reading.toObject() : reading;
  emit(SOCKET_EVENTS.SERVER.NEW_READING, payload);
};

const flushAnalytics = async (scope = 'realtime') => {
  if (!io) return;
  try {
    const data = scope === 'full'
      ? await analyticsService.getSummary()
      : await analyticsService.getRealtimeSnapshot();

    emit(SOCKET_EVENTS.SERVER.ANALYTICS_UPDATE, { scope, ...data });
  } catch (err) {
    console.error('Analytics broadcast failed:', err.message);
  }
};

const scheduleAnalyticsUpdate = (scope = 'realtime') => {
  pendingAnalyticsScope = pendingAnalyticsScope === 'full' || scope === 'full' ? 'full' : 'realtime';

  if (analyticsDebounceTimer) {
    clearTimeout(analyticsDebounceTimer);
  }

  analyticsDebounceTimer = setTimeout(() => {
    const flushScope = pendingAnalyticsScope;
    pendingAnalyticsScope = 'realtime';
    analyticsDebounceTimer = null;
    flushAnalytics(flushScope);
  }, ANALYTICS_DEBOUNCE_MS);
};

const emitReadingAndAnalytics = async (reading) => {
  emitNewReading(reading);
  scheduleAnalyticsUpdate('realtime');
};

const emitBlockchainEvent = (eventPayload) => {
  emit(SOCKET_EVENTS.SERVER.BLOCKCHAIN_EVENT, eventPayload);
};

const emitBlockchainEventWithAnalytics = (eventPayload) => {
  emitBlockchainEvent(eventPayload);
  scheduleAnalyticsUpdate('full');
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
