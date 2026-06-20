const { getRedisClient, isRedisAvailable } = require('../config/redis');

/**
 * Sub-module 3.4.2 — aggregated assistant chat analytics.
 *
 * Tracks three things, all as integer counters (no message/reply content):
 *   - intent distribution      (hash: field per intent)
 *   - retrieval hit rate       (hit / miss counters)
 *   - document RAG usage       (hash: field per docId + a "withDocs" counter)
 *
 * SECURITY (3.4 guardrails):
 * - AGGREGATED ONLY. Chat content (message, reply, retrieved_data) is NEVER
 *   stored. Only counts keyed by intent/source-type/docId are incremented.
 * - docIds are document slugs from the curated docs/ knowledge base, not user
 *   data. Storing them is safe and is the explicit "doc chunk usage" metric.
 * - Falls back to an in-memory map when Redis is unavailable so dev still
 *   surfaces numbers; single-instance only in that case.
 */

const KEY_INTENTS = 'assistant:analytics:intents';
const KEY_DOC_USAGE = 'assistant:analytics:doc_usage';
const KEY_COUNTERS = 'assistant:analytics:counters';

// Counter fields inside KEY_COUNTERS.
const F_TOTAL = 'total';
const F_WITH_DOCS = 'withDocs';
const F_RETRIEVAL_HIT = 'retrievalHit';
const F_RETRIEVAL_MISS = 'retrievalMiss';

// In-memory fallback (dev / Redis down).
const _mem = {
  intents: {},
  docUsage: {},
  counters: { [F_TOTAL]: 0, [F_WITH_DOCS]: 0, [F_RETRIEVAL_HIT]: 0, [F_RETRIEVAL_MISS]: 0 },
};

function redis() {
  const client = getRedisClient();
  return client && isRedisAvailable() ? client : null;
}

function _safeField(value, maxLen = 40) {
  const s = String(value == null ? 'unknown' : value).slice(0, maxLen);
  return s || 'unknown';
}

function _hincr(map, field) {
  map[field] = (map[field] || 0) + 1;
}

function _recordMem({ intent, sourceTypes, docIds, hadData }) {
  _hincr(_mem.intents, _safeField(intent));
  _mem.counters[F_TOTAL] += 1;
  if (hadData) _mem.counters[F_RETRIEVAL_HIT] += 1;
  else _mem.counters[F_RETRIEVAL_MISS] += 1;
  if (docIds && docIds.length) {
    _mem.counters[F_WITH_DOCS] += 1;
    for (const id of docIds) _hincr(_mem.docUsage, _safeField(id, 120));
  }
}

/**
 * Record one chat turn. Best-effort: never throws into the request path.
 */
async function recordChat({ intent, sourceTypes = [], docIds = [] }) {
  const hadData = Array.isArray(sourceTypes) && sourceTypes.length > 0;
  const client = redis();

  if (!client) {
    _recordMem({ intent, sourceTypes, docIds, hadData });
    return;
  }

  try {
    const pipeline = client.multi();
    pipeline.hincrby(KEY_INTENTS, _safeField(intent), 1);
    pipeline.hincrby(KEY_COUNTERS, F_TOTAL, 1);
    pipeline.hincrby(KEY_COUNTERS, hadData ? F_RETRIEVAL_HIT : F_RETRIEVAL_MISS, 1);
    if (docIds && docIds.length) {
      pipeline.hincrby(KEY_COUNTERS, F_WITH_DOCS, 1);
      for (const id of docIds) pipeline.hincrby(KEY_DOC_USAGE, _safeField(id, 120), 1);
    }
    await pipeline.exec();
  } catch (_) {
    // Fall back to memory so the metric is not lost on a transient Redis error.
    _recordMem({ intent, sourceTypes, docIds, hadData });
  }
}

function _toNumberMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v);
    out[k] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

async function getAnalytics() {
  const client = redis();
  if (!client) {
    return _snapshot(_mem.intents, _mem.docUsage, _mem.counters, 'memory');
  }

  try {
    const [intents, docUsage, counters] = await Promise.all([
      client.hgetall(KEY_INTENTS),
      client.hgetall(KEY_DOC_USAGE),
      client.hgetall(KEY_COUNTERS),
    ]);
    return _snapshot(
      _toNumberMap(intents),
      _toNumberMap(docUsage),
      _toNumberMap(counters),
      'redis',
    );
  } catch (_) {
    return _snapshot(_mem.intents, _mem.docUsage, _mem.counters, 'memory');
  }
}

function _snapshot(intents, docUsage, counters, backend) {
  const total = counters[F_TOTAL] || 0;
  const hits = counters[F_RETRIEVAL_HIT] || 0;
  const misses = counters[F_RETRIEVAL_MISS] || 0;
  const withDocs = counters[F_WITH_DOCS] || 0;
  const retrievalTotal = hits + misses;
  return {
    backend,
    totalChats: total,
    retrieval: {
      hits,
      misses,
      hitRate: retrievalTotal > 0 ? Number(((hits / retrievalTotal) * 100).toFixed(1)) : null,
    },
    docUsage: {
      chatsWithDocChunks: withDocs,
      topDocs: Object.entries(docUsage)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([docId, count]) => ({ docId, count })),
    },
    intentDistribution: Object.entries(intents)
      .sort((a, b) => b[1] - a[1])
      .map(([intent, count]) => ({ intent, count })),
  };
}

function resetForTests() {
  _mem.intents = {};
  _mem.docUsage = {};
  _mem.counters = { [F_TOTAL]: 0, [F_WITH_DOCS]: 0, [F_RETRIEVAL_HIT]: 0, [F_RETRIEVAL_MISS]: 0 };
}

module.exports = {
  recordChat,
  getAnalytics,
  resetForTests,
};
