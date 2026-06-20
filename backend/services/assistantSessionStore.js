const { getRedisClient, isRedisAvailable } = require('../config/redis');

/**
 * Sub-module 3.4.1 — optional assistant session store.
 *
 * Caches a COMPACT, PII-free snapshot of the last retrieved context per
 * `sessionId` so follow-up turns and analytics can reuse it without re-querying.
 *
 * SECURITY (3.4 guardrails):
 * - TTL is capped at 30 minutes; Redis expires the key automatically.
 * - Only redacted metadata is persisted by default: intent, source types, doc
 *   ids, period, timestamp. Node display names are the only identifiers and are
 *   already redacted of ObjectIds/email/wallet by the retrievers (3.2).
 * - The full sanitized context payload is cached ONLY when
 *   ASSISTANT_SESSION_CACHE_CONTEXT=true (opt-in). Even then it is the
 *   already-sanitized payload, never raw request bodies, JWTs, or wallet keys.
 * - Graceful no-op when Redis is unavailable (dev / single-instance).
 */

const SESSION_TTL_SECONDS = 30 * 60;
const KEY_PREFIX = 'assistant:session:';

function redis() {
  const client = getRedisClient();
  return client && isRedisAvailable() ? client : null;
}

function key(sessionId) {
  return `${KEY_PREFIX}${sessionId}`;
}

function buildSnapshot({ intent, sourceTypes, docIds, period, contextPayload }) {
  const snapshot = {
    intent: intent || 'unknown',
    sourceTypes: Array.isArray(sourceTypes) ? sourceTypes.slice(0, 12) : [],
    docIds: Array.isArray(docIds) ? docIds.slice(0, 12) : [],
    period: period || null,
    ts: Date.now(),
  };
  if (contextPayload != null) snapshot.context = contextPayload;
  return snapshot;
}

async function saveSnapshot(sessionId, fields = {}) {
  if (!sessionId) return;
  const client = redis();
  if (!client) return;
  try {
    await client.set(key(sessionId), JSON.stringify(buildSnapshot(fields)), 'EX', SESSION_TTL_SECONDS);
  } catch (_) {
    // Best-effort: a cache miss just means we re-query.
  }
}

async function getSnapshot(sessionId) {
  if (!sessionId) return null;
  const client = redis();
  if (!client) return null;
  try {
    const raw = await client.get(key(sessionId));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

async function clearSession(sessionId) {
  if (!sessionId) return;
  const client = redis();
  if (!client) return;
  try {
    await client.del(key(sessionId));
  } catch (_) {
    // ignore
  }
}

module.exports = {
  saveSnapshot,
  getSnapshot,
  clearSession,
  SESSION_TTL_SECONDS,
  buildSnapshot,
};
