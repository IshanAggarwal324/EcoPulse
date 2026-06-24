const EnergyReadingHourly = require('../models/EnergyReadingHourly');
const EnergyReading = require('../models/EnergyReading');
const AnomalyEvent = require('../models/AnomalyEvent');
const { getOwnedNodes } = require('../utils/nodeOwnership');
const { parsePeriod, resolveSinceDate } = require('../utils/periodHelpers');

/**
 * Sub-module 3.2.3 / 3.2.4 / 3.2.6 — user-scoped assistant retrievers.
 *
 * SECURITY (3.2 guardrails):
 * - Every retriever resolves the caller's owned nodes via `EnergyNode.find({ userId })`
 *   and queries ONLY those node ids. A nodeId passed from the client or message is
 *   rejected unless it belongs to the user (no cross-tenant data).
 * - Internal ObjectIds / userId / email are never returned; only node display
 *   names. The 8 KB cap is applied later by `sanitizeRetrievedData`.
 * - Heavier aggregations are wrapped in a 60s per-user+intent cache.
 */

const ANOMALY_SPIKE_FACTOR = 1.5;
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = parseInt(process.env.ASSISTANT_CACHE_MAX || '500', 10);

const _cache = new Map();

function pruneCache() {
  if (_cache.size <= CACHE_MAX_ENTRIES) return;
  const sorted = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const drop = sorted.slice(0, _cache.size - CACHE_MAX_ENTRIES);
  for (const [key] of drop) {
    _cache.delete(key);
  }
}

function withCache(key, ttlMs, fn) {
  const hit = _cache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < ttlMs) {
    return hit.value;
  }
  const value = fn();
  if (value && typeof value.then === 'function') {
    return value.then((v) => {
      _cache.set(key, { ts: Date.now(), value: v });
      pruneCache();
      return v;
    });
  }
  _cache.set(key, { ts: now, value });
  pruneCache();
  return value;
}

function clearAssistantCache() {
  _cache.clear();
}

async function getOwnedNodeIds(userId) {
  const nodes = await getOwnedNodes(userId);
  return nodes;
}

async function _getNodeMap(userId) {
  const nodes = await getOwnedNodeIds(userId);
  const map = new Map();
  for (const n of nodes) map.set(n._id.toString(), n);
  return map;
}

/**
 * Resolve a node id from an explicit hint or a free-text message. Only returns
 * a node id that is owned by `userId`; otherwise null. Prevents a user from
 * referencing another tenant's node.
 */
async function resolveNodeIdFromMessage(userId, message, explicitNodeId) {
  const nodes = await getOwnedNodeIds(userId);
  const byId = new Map(nodes.map((n) => [n._id.toString(), n]));

  if (explicitNodeId && byId.has(String(explicitNodeId))) {
    return String(explicitNodeId);
  }

  if (message && typeof message === 'string') {
    const lower = message.toLowerCase();
    for (const n of nodes) {
      if (n.name && lower.includes(n.name.toLowerCase())) {
        return n._id.toString();
      }
    }
    const m = message.match(/\b[0-9a-fA-F]{24}\b/);
    if (m && byId.has(m[0])) return m[0];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Pure computation helpers (unit-tested without a database)            */
/* ------------------------------------------------------------------ */

function computeBillAnalysis(current, prior, perNodeCurrent, perNodePrior) {
  const totalConsumedKwh = round1(current?.totalConsumed ?? 0);
  const priorPeriodConsumedKwh = round1(prior?.totalConsumed ?? 0);

  let deltaPercent = null;
  if (priorPeriodConsumedKwh > 0) {
    deltaPercent = Math.round(
      ((totalConsumedKwh - priorPeriodConsumedKwh) / priorPeriodConsumedKwh) * 100,
    );
  }

  const topNodes = (perNodeCurrent || [])
    .map((n) => ({ name: n.name, consumedKwh: round1(n.totalConsumed ?? 0) }))
    .filter((n) => n.consumedKwh > 0)
    .sort((a, b) => b.consumedKwh - a.consumedKwh)
    .slice(0, 3);

  const priorByName = new Map((perNodePrior || []).map((n) => [n.name, n.totalConsumed ?? 0]));
  const anomalies = [];
  for (const n of perNodeCurrent || []) {
    const prev = priorByName.get(n.name) ?? 0;
    if (prev > 0 && (n.totalConsumed ?? 0) >= prev * ANOMALY_SPIKE_FACTOR) {
      anomalies.push({
        name: n.name,
        reason: `Consumption up ${Math.round(((n.totalConsumed - prev) / prev) * 100)}% vs prior period`,
      });
    }
  }

  return {
    totalConsumedKwh,
    priorPeriodConsumedKwh,
    deltaPercent,
    topNodes,
    anomalies,
  };
}

function round1(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

/* ------------------------------------------------------------------ */
/* DB-backed retrievers                                                */
/* ------------------------------------------------------------------ */

async function _hourlyTotals(nodeIds, since, until) {
  if (!nodeIds.length) return { totalGenerated: 0, totalConsumed: 0, readingCount: 0 };
  const match = {
    nodeId: { $in: nodeIds },
    hour: { $gte: since, ...(until ? { $lt: until } : {}) },
  };
  const [row] = await EnergyReadingHourly.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalGenerated: { $sum: '$energyGenerated' },
        totalConsumed: { $sum: '$energyConsumed' },
        readingCount: { $sum: '$readingCount' },
      },
    },
  ]);
  return {
    totalGenerated: row?.totalGenerated || 0,
    totalConsumed: row?.totalConsumed || 0,
    readingCount: row?.readingCount || 0,
  };
}

async function _hourlyPerNode(nodeIds, since, until) {
  if (!nodeIds.length) return [];
  const match = {
    nodeId: { $in: nodeIds },
    hour: { $gte: since, ...(until ? { $lt: until } : {}) },
  };
  return EnergyReadingHourly.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$nodeId',
        totalConsumed: { $sum: '$energyConsumed' },
        totalGenerated: { $sum: '$energyGenerated' },
      },
    },
  ]);
}

function _labelNodes(rows, nodeMap) {
  return rows.map((r) => ({
    name: nodeMap.get(String(r._id))?.name || 'Unnamed node',
    totalConsumed: r.totalConsumed || 0,
    totalGenerated: r.totalGenerated || 0,
  }));
}

/**
 * 3.2.3 — Recent energy readings for the caller (optionally a single owned node),
 * using the hourly rollup collection. Returns compact totals + a short daily
 * series, all scoped to the user's nodes.
 */
async function retrieveRecentReadings(userId, nodeId, hours = 168) {
  if (!userId) return emptyResult('Sign in to see your recent readings.');
  const cacheKey = `recent:${userId}:${nodeId || 'all'}:${hours}`;
  return withCache(cacheKey, CACHE_TTL_MS, async () => {
    const nodes = await getOwnedNodeIds(userId);
    const nodeMap = new Map(nodes.map((n) => [n._id.toString(), n]));
    const ownedIds = nodes.map((n) => n._id);
    const scopedIds = nodeId && nodeMap.has(String(nodeId)) ? [nodeMap.get(String(nodeId))._id] : ownedIds;

    if (!scopedIds.length) return emptyResult('You have no nodes with readings yet.');

    const span = Math.min(Math.max(Number(hours) || 168, 1), 720);
    const since = resolveSinceDate(span);
    const [totals, perNode, series] = await Promise.all([
      _hourlyTotals(scopedIds, since),
      _hourlyPerNode(scopedIds, since),
      _dailySeries(scopedIds, since),
    ]);

    const nodeName = nodeId && nodeMap.has(String(nodeId)) ? nodeMap.get(String(nodeId)).name : null;

    return {
      retrieved_data: {
        scope: nodeName ? { nodeName } : { nodeCount: scopedIds.length },
        totalConsumedKwh: round1(totals.totalConsumed),
        totalGeneratedKwh: round1(totals.totalGenerated),
        readingCount: totals.readingCount,
        periodHours: span,
        topNodes: _labelNodes(perNode, nodeMap)
          .map((n) => ({ name: n.name, consumedKwh: round1(n.totalConsumed) }))
          .sort((a, b) => b.consumedKwh - a.consumedKwh)
          .slice(0, 3),
        dailySeries: series,
      },
      sources: [{ type: 'reading', label: `Recent readings (${span}h)`, endpoint: 'energyreadings_hourly' }],
    };
  });
}

async function _dailySeries(nodeIds, since) {
  if (!nodeIds.length) return [];
  const rows = await EnergyReadingHourly.aggregate([
    { $match: { nodeId: { $in: nodeIds }, hour: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$hour' } },
        consumed: { $sum: '$energyConsumed' },
        generated: { $sum: '$energyGenerated' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.slice(-14).map((r) => ({
    date: r._id,
    consumedKwh: round1(r.consumed || 0),
    generatedKwh: round1(r.generated || 0),
  }));
}

/**
 * Best-effort ML anomaly enrichment (Module 4.1.7). Pulls recent persisted
 * AnomalyEvent docs for the user's nodes and surfaces display-safe summaries
 * into the assistant context. Fail-safe: never throws into the retriever.
 */
async function _recentMlAnomalies(ownedIds, nodeMap, since, limit = 8) {
  if (!ownedIds || !ownedIds.length) return [];
  try {
    const query = { nodeId: { $in: ownedIds }, dismissedAt: null };
    if (since) query.timestamp = { $gte: since };
    const docs = await AnomalyEvent.find(query)
      .sort({ score: -1, timestamp: -1 })
      .limit(limit)
      .lean();
    return docs.map((d) => ({
      nodeName: (nodeMap.get(String(d.nodeId)) || {}).name || 'Node',
      timestamp: d.timestamp,
      reasonCode: d.reasonCode,
      score: typeof d.score === 'number' ? Math.round(d.score * 100) / 100 : null,
    }));
  } catch (err) {
    console.error('ML anomaly retrieval failed:', err.message);
    return [];
  }
}

/**
 * 3.2.4 — Bill / usage analysis: current vs prior period consumption, top
 * consuming nodes, and anomaly flags for sudden spikes.
 */
async function retrieveBillAnalysis(userId, period) {
  if (!userId) return emptyResult('Sign in to see your bill analysis.');
  const cacheKey = `bill:${userId}:${period || '7d'}`;
  return withCache(cacheKey, CACHE_TTL_MS, async () => {
    const parsed = parsePeriod(period || '7d');
    const hours = parsed ? parsed.sinceHours : 168;
    const now = new Date();
    const currentSince = resolveSinceDate(hours);
    const priorSince = new Date(now.getTime() - 2 * hours * 60 * 60 * 1000);
    const priorUntil = currentSince;

    const nodes = await getOwnedNodeIds(userId);
    const nodeMap = new Map(nodes.map((n) => [n._id.toString(), n]));
    const ownedIds = nodes.map((n) => n._id);

    if (!ownedIds.length) return emptyResult('You have no nodes to analyze yet.');

    const [cur, prev, curPerNode, prevPerNode] = await Promise.all([
      _hourlyTotals(ownedIds, currentSince),
      _hourlyTotals(ownedIds, priorSince, priorUntil),
      _hourlyPerNode(ownedIds, currentSince),
      _hourlyPerNode(ownedIds, priorSince, priorUntil),
    ]);

    const labeledCurrent = _labelNodes(curPerNode, nodeMap);
    const labeledPrior = _labelNodes(prevPerNode, nodeMap);

    const analysis = computeBillAnalysis(cur, prev, labeledCurrent, labeledPrior);
    const mlAnomalies = await _recentMlAnomalies(ownedIds, nodeMap, currentSince);

    return {
      retrieved_data: {
        period: parsed ? parsed.label : `Last ${hours}h`,
        ...analysis,
        mlAnomalies,
      },
      sources: [
        { type: 'bill', label: 'Bill analysis', endpoint: 'energyreadings_hourly' },
        { type: 'anomaly', label: 'Grid anomaly alerts', endpoint: 'anomalyevents' },
      ],
    };
  });
}

/**
 * 3.2.6 — User-owned node context: status + last reading summary per node.
 * Internal ids are stripped; only display names are exposed.
 */
async function retrieveUserNodes(userId) {
  if (!userId) return emptyResult('Sign in to see your nodes.');
  const cacheKey = `nodes:${userId}`;
  return withCache(cacheKey, CACHE_TTL_MS, async () => {
    const nodes = await getOwnedNodeIds(userId);
    if (!nodes.length) return emptyResult('You have no nodes registered.');

    const nodeIds = nodes.map((n) => n._id);
    const lastByNode = await EnergyReadingHourly.aggregate([
      { $match: { nodeId: { $in: nodeIds } } },
      { $sort: { hour: -1 } },
      { $group: { _id: '$nodeId', lastHour: { $first: '$hour' }, generated: { $first: '$energyGenerated' }, consumed: { $first: '$energyConsumed' } } },
    ]);
    const lastMap = new Map(lastByNode.map((r) => [String(r._id), r]));

    const nodeList = nodes.map((n) => {
      const last = lastMap.get(n._id.toString());
      return {
        name: n.name,
        nodeType: n.nodeType,
        status: n.status,
        lastReading: last
          ? {
              at: last.lastHour,
              generatedKwh: round1(last.generated || 0),
              consumedKwh: round1(last.consumed || 0),
            }
          : null,
      };
    });

    return {
      retrieved_data: {
        nodeCount: nodeList.length,
        activeCount: nodeList.filter((n) => n.status === 'active').length,
        nodes: nodeList,
      },
      sources: [{ type: 'nodes', label: 'User nodes', endpoint: 'energyreadings_hourly' }],
    };
  });
}

function emptyResult(explanation) {
  return {
    retrieved_data: { explanation },
    sources: [],
  };
}

module.exports = {
  retrieveRecentReadings,
  retrieveBillAnalysis,
  retrieveUserNodes,
  resolveNodeIdFromMessage,
  computeBillAnalysis,
  withCache,
  clearAssistantCache,
};
