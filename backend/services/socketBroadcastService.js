const analyticsService = require('./analytics');
const { SOCKET_EVENTS } = require('../socket/events');
const { logger } = require('../utils/logger');
const { shapeTradeTickerItem } = require('./tradeHistoryService');

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

/**
 * Module 9.4 — push a compact, anonymized trade to the live ticker. Accepts a
 * raw trade (DB lean doc or a realtime contract-event payload). The item is
 * sanitized/anonymized by `shapeTradeTickerItem`; malformed input is dropped.
 *
 * Emits to the `authenticated` room only.
 */
const emitTradeExecuted = (trade) => {
  if (!io) return;
  const item = shapeTradeTickerItem(trade);
  if (!item) return;
  emit(SOCKET_EVENTS.SERVER.TRADE_EXECUTED, item);
};

// ---------------------------------------------------------------------------
// Module 9.6 — settlement lifecycle push (SECURITY-CRITICAL scoping)
// ---------------------------------------------------------------------------
// Settlement events carry per-trade private data (txHash, verification status,
// delivery delta, mismatch flags). They MUST be delivered only to the buyer and
// seller wallet rooms — never to the global `authenticated` room. Broadcasting
// them to every logged-in client is an information-disclosure vulnerability.
// `notificationService` already follows this user-scoped pattern; this mirrors it.

const normalizeWallet = (addr) =>
  typeof addr === 'string' && addr ? addr.trim().toLowerCase() : '';

const numOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const SETTLEMENT_MISMATCH_FLAG_RE = /^[A-Z0-9_]{1,40}$/;

/**
 * Whitelist + coerce a settlement payload before it ever touches the wire.
 * Unknown keys are dropped (defense-in-depth against leaking future fields,
 * secrets, or nested PII a caller might attach). Returns null if the payload
 * cannot be safely delivered (no valid txHash or settlementId).
 */
const sanitizeSettlementPayload = (payload = {}) => {
  if (!payload || typeof payload !== 'object') return null;

  const txHash =
    typeof payload.txHash === 'string' && /^0x[a-f0-9]{64}$/i.test(payload.txHash)
      ? payload.txHash.toLowerCase()
      : null;

  const settlementId =
    typeof payload.settlementId === 'string' && payload.settlementId
      ? String(payload.settlementId).slice(0, 64)
      : null;

  // Must carry at least one stable identifier so a client can act on it.
  if (!txHash && !settlementId) return null;

  const listingId = numOrNull(payload.listingId);

  const mismatchFlags = Array.isArray(payload.mismatchFlags)
    ? payload.mismatchFlags
        .filter((f) => typeof f === 'string' && SETTLEMENT_MISMATCH_FLAG_RE.test(f))
        .slice(0, 8)
    : [];

  return {
    settlementId,
    txHash,
    listingId: Number.isFinite(listingId) ? listingId : null,
    verificationStatus:
      typeof payload.verificationStatus === 'string' &&
      ['pending', 'verified', 'mismatch', 'disputed'].includes(payload.verificationStatus)
        ? payload.verificationStatus
        : null,
    deltaPct: numOrNull(payload.deltaPct),
    mismatchFlags,
    at: new Date().toISOString(),
  };
};

/**
 * Emit a settlement lifecycle transition to ONLY the buyer and seller wallet
 * rooms. Never falls back to a global broadcast — if neither wallet is known
 * the event is dropped (and logged) rather than leaked.
 *
 * @param {'verified'|'mismatch'} status
 * @param {object} payload  raw settlement fields (sanitized internally)
 * @param {{ seller?: string, buyer?: string }} [wallets] explicit party wallets
 */
const emitSettlementEvent = (status, payload = {}, wallets = {}) => {
  if (!io) return;

  const safe = sanitizeSettlementPayload(payload);
  if (!safe) return;

  const seller = normalizeWallet(wallets.seller ?? payload.seller);
  const buyer = normalizeWallet(wallets.buyer ?? payload.buyer);

  const targets = new Set();
  if (seller) targets.add(`wallet:${seller}`);
  if (buyer) targets.add(`wallet:${buyer}`);

  if (!targets.size) {
    // No party to scope to. Dropping is intentional — a global fallback is the
    // exact disclosure this guard exists to prevent.
    logger.warn('settlement socket event dropped: no scoppable wallet', {
      component: 'socket',
      status,
      settlementId: safe.settlementId,
    });
    return;
  }

  const event =
    status === 'verified'
      ? SOCKET_EVENTS.SERVER.SETTLEMENT_VERIFIED
      : SOCKET_EVENTS.SERVER.SETTLEMENT_MISMATCH;

  for (const room of targets) {
    io.to(room).emit(event, safe);
  }
};

const emitSettlementVerified = (payload, wallets) =>
  emitSettlementEvent('verified', payload, wallets);

const emitSettlementMismatch = (payload, wallets) =>
  emitSettlementEvent('mismatch', payload, wallets);

module.exports = {
  setIo,
  emitNewReading,
  flushAnalytics,
  scheduleAnalyticsUpdate,
  emitReadingAndAnalytics,
  emitBlockchainEvent,
  emitBlockchainEventWithAnalytics,
  emitOrderbookUpdate,
  emitTradeExecuted,
  emitSettlementVerified,
  emitSettlementMismatch,
  // Exposed for tests / advanced callers.
  sanitizeSettlementPayload,
  normalizeWallet,
};
