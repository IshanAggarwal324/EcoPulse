const EnergyNode = require('../models/EnergyNode');
const AnomalyEvent = require('../models/AnomalyEvent');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const {
  isPrivileged,
  assertNodeOwnership,
  assertNodesOwnership,
  getOwnedNodeIds,
} = require('../utils/nodeOwnership');

const { getAiServiceUrl } = require('../config/serviceUrls');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');

const AI_SERVICE_URL = getAiServiceUrl();
const INTERNAL_SERVICE_API_KEY = process.env.INTERNAL_SERVICE_API_KEY || '';
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !INTERNAL_SERVICE_API_KEY) {
  throw new Error('INTERNAL_SERVICE_API_KEY must be set in production');
}

// Bounded input/output constants — keep each within safe production limits.
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const MAX_BATCH_NODES = 50;
const MAX_PERSIST = parseInt(process.env.ANOMALY_MAX_PERSIST || '200', 10);
const MAX_SINCE_AGE_DAYS = Math.max(
  7,
  parseInt(process.env.ANOMALY_MAX_SINCE_DAYS || '365', 10),
);
// Strict ObjectId format. Rejecting anything else prevents NoSQL-injection
// style object payloads (e.g. { $ne: ... }) from reaching Mongo.
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

const safeUpstreamErrorDetails = async (response) => {
  if (isProduction) return undefined;
  const text = await response.text();
  return text.slice(0, 500);
};

const buildInternalHeaders = () => ({
  'Content-Type': 'application/json',
  ...(INTERNAL_SERVICE_API_KEY ? { 'x-internal-api-key': INTERNAL_SERVICE_API_KEY } : {}),
});

function parseDays(raw) {
  const parsed = parseInt(raw || '7', 10);
  if (!Number.isFinite(parsed) || parsed < MIN_DAYS || parsed > MAX_DAYS) {
    throw new ApiError(
      `days must be between ${MIN_DAYS} and ${MAX_DAYS}`,
      400,
      'INVALID_ANOMALY_DAYS',
    );
  }
  return parsed;
}

function parseNodeId(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!OBJECT_ID_RE.test(value)) {
    throw new ApiError('nodeId must be a valid id', 400, 'INVALID_NODE_ID');
  }
  return value;
}

function parseNodeIds(raw) {
  if (!raw) return [];
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = [];
  for (const part of parts) {
    if (!OBJECT_ID_RE.test(part)) {
      throw new ApiError('Every nodeIds entry must be a valid id', 400, 'INVALID_NODE_ID');
    }
    ids.push(part);
  }
  if (ids.length > MAX_BATCH_NODES) {
    throw new ApiError(
      `nodeIds supports at most ${MAX_BATCH_NODES} ids`,
      400,
      'TOO_MANY_NODE_IDS',
    );
  }
  return ids;
}

function parseSince(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError('since must be a valid ISO date', 400, 'INVALID_SINCE');
  }
  const now = Date.now();
  if (date.getTime() > now) {
    throw new ApiError('since cannot be in the future', 400, 'INVALID_SINCE');
  }
  const minAllowed = now - MAX_SINCE_AGE_DAYS * 86400000;
  if (date.getTime() < minAllowed) {
    throw new ApiError(
      `since cannot be older than ${MAX_SINCE_AGE_DAYS} days`,
      400,
      'INVALID_SINCE',
    );
  }
  return date;
}

async function callAiAnomalyScore(body) {
  return fetchWithTimeout(`${AI_SERVICE_URL}/anomaly/score`, {
    method: 'POST',
    headers: buildInternalHeaders(),
    body: JSON.stringify(body),
  });
}

async function callAiAnomalyBatch(body) {
  return fetchWithTimeout(`${AI_SERVICE_URL}/anomaly/batch`, {
    method: 'POST',
    headers: buildInternalHeaders(),
    body: JSON.stringify(body),
  });
}

/**
 * Persist flagged readings for one node's score result. Idempotent via the
 * unique (userId, nodeId, timestamp, reasonCode) index. Capped to MAX_PERSIST.
 */
async function persistFlagged(userId, scoreResult, since) {
  const flagged = (scoreResult && scoreResult.flagged) || [];
  const nodeId = scoreResult && scoreResult.node_id;
  if (!flagged.length || !nodeId) return 0;

  const ops = [];
  for (const f of flagged) {
    if (!f || f.is_anomaly !== true) continue;
    const ts = new Date(f.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    if (since && ts < since) continue;
    const reasonCode = (f.reason_codes && f.reason_codes[0]) || 'ml_anomaly';
    ops.push({
      updateOne: {
        filter: { userId, nodeId, timestamp: ts, reasonCode },
        update: {
          $setOnInsert: {
            userId,
            nodeId,
            timestamp: ts,
            reasonCode,
            reasonCodes: Array.isArray(f.reason_codes) ? f.reason_codes : [reasonCode],
            score: typeof f.anomaly_score === 'number' ? f.anomaly_score : null,
            generation: typeof f.generation === 'number' ? f.generation : null,
            consumption: typeof f.consumption === 'number' ? f.consumption : null,
          },
        },
        upsert: true,
      },
    });
    if (ops.length >= MAX_PERSIST) break;
  }

  if (ops.length) {
    await AnomalyEvent.bulkWrite(ops, { ordered: false });
  }
  return ops.length;
}

/**
 * GET /api/v1/anomaly?nodeId=&nodeIds=&allNodes=&days=&since=&persist=
 *
 * Proxies to the AI anomaly service with ownership enforcement (IDOR guard).
 * A non-privileged user may only score nodes they own; admins may request
 * allNodes. Flagged readings are persisted for audit unless persist=false.
 */
const getAnomalies = asyncHandler(async (req, res) => {
  const days = parseDays(req.query.days);
  const since = parseSince(req.query.since);
  const nodeId = parseNodeId(req.query.nodeId);
  const nodeIdsParam = parseNodeIds(req.query.nodeIds);
  const allNodes = req.query.allNodes === 'true';
  const persist = req.query.persist !== 'false';
  const privileged = isPrivileged(req.user);

  // ---- IDOR / authorization ----------------------------------------------
  let targetNodeIds = [];
  if (nodeId) {
    targetNodeIds = [nodeId];
  } else if (nodeIdsParam.length) {
    targetNodeIds = nodeIdsParam;
  }

  if (targetNodeIds.length) {
    if (!privileged) {
      // Throws ApiError(403) if any node is not owned by the user.
      await assertNodesOwnership(req.user._id, targetNodeIds);
    }
  } else if (allNodes && privileged) {
    // Admin global scan — bounded to MAX_BATCH_NODES to keep the upstream
    // batch request within safe limits.
    const docs = await EnergyNode.find({}, { _id: 1 })
      .limit(MAX_BATCH_NODES)
      .lean();
    targetNodeIds = docs.map((d) => String(d._id));
  } else {
    // Default: the caller's own nodes (capped). The allNodes flag is ignored
    // for non-privileged users so they cannot enumerate others' nodes.
    const owned = await getOwnedNodeIds(req.user._id);
    targetNodeIds = (owned || []).slice(0, MAX_BATCH_NODES);
  }

  if (!targetNodeIds.length) {
    return res.status(200).json({
      flagged: [],
      flagged_count: 0,
      total_readings: 0,
      window_days: days,
      model_status: 'no_nodes',
      since: since ? since.toISOString() : null,
      meta: { nodeCount: 0 },
    });
  }

  const aiBody = { window_days: days };

  // ---- Single-node path ---------------------------------------------------
  if (targetNodeIds.length === 1) {
    aiBody.node_id = targetNodeIds[0];

    let response;
    try {
      response = await callAiAnomalyScore(aiBody);
    } catch (error) {
      return res.status(503).json({
        success: false,
        message: 'Anomaly service unavailable',
        ...(!isProduction ? { details: error.message } : {}),
      });
    }

    if (!response.ok) {
      const errorDetails = await safeUpstreamErrorDetails(response);
      return res.status(response.status).json({
        success: false,
        message: 'Error communicating with anomaly service',
        ...(errorDetails ? { details: errorDetails } : {}),
      });
    }

    const data = await response.json();
    let persisted = 0;
    if (persist) {
      try {
        persisted = await persistFlagged(req.user._id, { ...data, node_id: targetNodeIds[0] }, since);
      } catch (err) {
        // Persistence must never break the response; audit storage is best-effort.
        console.error('Anomaly persist failed:', err.message);
      }
    }

    return res.status(200).json({
      node_id: targetNodeIds[0],
      window_days: data.window_days,
      model_status: data.model_status || 'ready',
      model_version: data.model_version || null,
      total_readings: data.total_readings || 0,
      flagged_count: data.flagged_count || 0,
      flagged: data.flagged || [],
      persisted,
      since: since ? since.toISOString() : null,
      meta: { nodeCount: 1 },
    });
  }

  // ---- Batch path ---------------------------------------------------------
  aiBody.node_ids = targetNodeIds;

  let response;
  try {
    response = await callAiAnomalyBatch(aiBody);
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: 'Anomaly service unavailable',
      ...(!isProduction ? { details: error.message } : {}),
    });
  }

  if (!response.ok) {
    const errorDetails = await safeUpstreamErrorDetails(response);
    return res.status(response.status).json({
      success: false,
      message: 'Error communicating with anomaly service',
      ...(errorDetails ? { details: errorDetails } : {}),
    });
  }

  const data = await response.json();
  const results = data.results || [];
  let persisted = 0;
  if (persist) {
    for (const r of results) {
      try {
        persisted += await persistFlagged(req.user._id, r, since);
      } catch (err) {
        console.error('Anomaly persist failed:', err.message);
      }
    }
  }

  return res.status(200).json({
    results,
    flagged_count: results.reduce((sum, r) => sum + (r.flagged_count || 0), 0),
    model_status: data.model_status || 'ready',
    model_version: data.model_version || null,
    persisted,
    since: since ? since.toISOString() : null,
    meta: { nodeCount: results.length },
  });
});

module.exports = { getAnomalies };
