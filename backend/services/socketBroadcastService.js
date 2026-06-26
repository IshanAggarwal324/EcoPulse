const analyticsService = require('./analytics');
const { SOCKET_EVENTS } = require('../socket/events');
const { logger } = require('../utils/logger');

let io = null;
let analyticsDebounceTimer = null;
let pendingAnalyticsScope = 'realtime';
let lastFlushAt = 0;
let cachedSnapshot = { at: 0, scope: null, data: null };

const ANALYTICS_DEBOUNCE_MS = parseInt(
  process.env.SOCKET_ANALYTICS_DEBOUNCE_MS || '750',
  10,
);

const MIN_ANALYTICS_FLUSH_MS = parseInt(
  process.env.SOCKET_MIN_ANALYTICS_FLUSH_MS || '2000',
  10,
);

const ANALYTICS_SNAPSHOT_TTL_MS = parseInt(
  process.env.SOCKET_ANALYTICS_SNAPSHOT_TTL_MS || '2000',
  10,
);

const READING_BROADCAST_ENABLED = () =>
  String(process.env.SOCKET_READING_BROADCAST || 'true').toLowerCase() !== 'false';

const setIo = (socketIo) => {
  io = socketIo;
};

const emit = (event, payload) => {
  if (!io) return;
  io.to('authenticated').emit(event, payload);
};

const emitNewReading = (reading) => {
  if (!READING_BROADCAST_ENABLED()) return;
  const payload = reading?.toObject ? reading.toObject() : reading;
  emit(SOCKET_EVENTS.SERVER.NEW_READING, payload);
};

const flushAnalytics = async (scope = 'realtime') => {
  if (!io) return;

  const now = Date.now();
  if (
    scope === 'realtime'
    && cachedSnapshot.data
    && cachedSnapshot.scope === 'realtime'
    && now - cachedSnapshot.at < ANALYTICS_SNAPSHOT_TTL_MS
  ) {
    emit(SOCKET_EVENTS.SERVER.ANALYTICS_UPDATE, { scope, ...cachedSnapshot.data });
    lastFlushAt = now;
    return;
  }

  try {
    const data = scope === 'full'
      ? await analyticsService.getSummary()
      : await analyticsService.getRealtimeSnapshot();

    cachedSnapshot = { at: now, scope, data };
    lastFlushAt = now;
    emit(SOCKET_EVENTS.SERVER.ANALYTICS_UPDATE, { scope, ...data });
  } catch (err) {
    logger.warn('analytics broadcast failed', { err, scope, component: 'socket' });
  }
};

const scheduleAnalyticsUpdate = (scope = 'realtime') => {
  pendingAnalyticsScope = pendingAnalyticsScope === 'full' || scope === 'full' ? 'full' : 'realtime';

  if (analyticsDebounceTimer) {
    clearTimeout(analyticsDebounceTimer);
  }

  const delay = Math.max(ANALYTICS_DEBOUNCE_MS, MIN_ANALYTICS_FLUSH_MS);

  analyticsDebounceTimer = setTimeout(() => {
    const flushScope = pendingAnalyticsScope;
    pendingAnalyticsScope = 'realtime';
    analyticsDebounceTimer = null;
    flushAnalytics(flushScope);
  }, delay);
};

const emitReadingAndAnalytics = (reading) => {
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

/**
 * Push an order-book update (Sub-module 6.1.4). Payload is a compact diff
 * signal — the reason + a short summary — NOT the full book. Clients refetch
 * their visible page. Emits to authenticated clients only.
 *
 * @param {{ reason?: string, changedListingIds?: number[], summary?: object }} payload
 */
const emitOrderbookUpdate = (payload = {}) => {
  if (!io) return;
  const safe =
    payload && typeof payload === 'object'
      ? {
          reason: typeof payload.reason === 'string' ? payload.reason : 'update',
          changedListingIds: Array.isArray(payload.changedListingIds)
            ? payload.changedListingIds.slice(0, 200).map((n) => Number(n)).filter((n) => Number.isFinite(n))
            : [],
          summary: payload.summary || null,
          at: new Date().toISOString(),
        }
      : { reason: 'update', at: new Date().toISOString() };
  emit(SOCKET_EVENTS.SERVER.ORDERBOOK_UPDATE, safe);
};

module.exports = {
  setIo,
  emitNewReading,
  flushAnalytics,
  scheduleAnalyticsUpdate,
  emitReadingAndAnalytics,
  emitBlockchainEvent,
  emitBlockchainEventWithAnalytics,
  emitOrderbookUpdate,
};
