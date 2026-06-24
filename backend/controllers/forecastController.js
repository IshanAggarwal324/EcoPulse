const EnergyReading = require('../models/EnergyReading');
const EnergyNode = require('../models/EnergyNode');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const {
  isPrivileged,
  getOwnedNodeIds,
  assertNodeOwnership,
  assertNodesOwnership,
} = require('../utils/nodeOwnership');
const { mergeForecastPredictions } = require('../utils/forecastMerge');

const { getAiServiceUrl } = require('../config/serviceUrls');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');

const AI_SERVICE_URL = getAiServiceUrl();
const INTERNAL_SERVICE_API_KEY = process.env.INTERNAL_SERVICE_API_KEY || '';
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !INTERNAL_SERVICE_API_KEY) {
  throw new Error('INTERNAL_SERVICE_API_KEY must be set in production');
}

const safeUpstreamErrorDetails = async (response) => {
  if (isProduction) return undefined;
  const text = await response.text();
  return text.slice(0, 500);
};

const buildInternalHeaders = () => ({
  'Content-Type': 'application/json',
  ...(INTERNAL_SERVICE_API_KEY ? { 'x-internal-api-key': INTERNAL_SERVICE_API_KEY } : {}),
});

const MIN_FORECAST_DAYS = 1;
const MAX_FORECAST_DAYS = 90;

// Module 4.3.6 — allowed native multi-horizon output sizes (must mirror the
// AI service allow-list). Restricting here rejects oversized horizons at the
// edge instead of letting them reach model inference.
const ALLOWED_FORECAST_HORIZONS = new Set([1, 7, 14, 30]);
const VALID_MODEL_SCOPES = new Set(['global', 'per_node']);

const parseForecastDays = (raw) => {
  const parsed = parseInt(raw || '7', 10);
  if (!Number.isFinite(parsed) || parsed < MIN_FORECAST_DAYS || parsed > MAX_FORECAST_DAYS) {
    throw new ApiError(
      `days must be between ${MIN_FORECAST_DAYS} and ${MAX_FORECAST_DAYS}`,
      400,
      'INVALID_FORECAST_DAYS',
    );
  }
  return parsed;
};

const parseForecastHorizon = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || !ALLOWED_FORECAST_HORIZONS.has(parsed)) {
    throw new ApiError(
      `horizon must be one of ${[...ALLOWED_FORECAST_HORIZONS].sort((a, b) => a - b).join(', ')}`,
      400,
      'INVALID_FORECAST_HORIZON',
    );
  }
  return parsed;
};

const parseModelScope = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim().toLowerCase();
  if (!VALID_MODEL_SCOPES.has(value)) {
    throw new ApiError(
      `modelScope must be one of ${[...VALID_MODEL_SCOPES].join(', ')}`,
      400,
      'INVALID_MODEL_SCOPE',
    );
  }
  return value;
};

async function callAiForecast(body) {
  const response = await fetchWithTimeout(`${AI_SERVICE_URL}/forecast/`, {
    method: 'POST',
    headers: buildInternalHeaders(),
    body: JSON.stringify(body),
  });
  return response;
}

async function callAiBatchForecast(body) {
  const response = await fetchWithTimeout(`${AI_SERVICE_URL}/forecast/batch`, {
    method: 'POST',
    headers: buildInternalHeaders(),
    body: JSON.stringify(body),
  });
  return response;
}

// Module 4.2.5 — confidence / calibration surface proxy.
const VERSION_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function callAiConfidence(modelVersion) {
  const qs = modelVersion ? `?model_version=${encodeURIComponent(modelVersion)}` : '';
  const response = await fetchWithTimeout(`${AI_SERVICE_URL}/forecast/confidence${qs}`, {
    method: 'GET',
    headers: buildInternalHeaders(),
  });
  return response;
}

async function shouldUseDummyData(forceDummy, nodeId = null) {
  if (forceDummy) return true;
  const query = nodeId ? { nodeId } : {};
  const readingCount = await EnergyReading.countDocuments(query);
  return readingCount < 30;
}

async function shouldUseDummyDataForNodes(nodeIds) {
  if (!nodeIds.length) return true;
  const readingCount = await EnergyReading.countDocuments({ nodeId: { $in: nodeIds } });
  return readingCount < 30;
}

function buildDummyWarning(useDummyData) {
  if (!useDummyData) return undefined;
  return isProduction
    ? 'FORECAST DATA IS SIMULATED — no real model or sufficient readings available. Do not use for decisions.'
    : 'Forecast based on simulated/dummy data.';
}

function parseNodeIdsParam(nodeIdsParam) {
  if (!nodeIdsParam) return [];
  return nodeIdsParam
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

async function resolveBatchNodeIds(req, { allNodes, nodeIdsParam }) {
  const privileged = isPrivileged(req.user);

  if (allNodes) {
    if (privileged) {
      const nodes = await EnergyNode.find().select('_id name');
      return nodes.map((n) => n._id.toString());
    }
    return getOwnedNodeIds(req.user._id);
  }

  const parsed = parseNodeIdsParam(nodeIdsParam);
  if (!parsed.length) return [];

  if (privileged) return parsed;
  return assertNodesOwnership(req.user._id, parsed);
}

async function runBatchForecast({ nodeIds, daysToPredict, forceDummy, horizon, modelScope }) {
  if (!nodeIds.length) {
    throw new ApiError('No energy nodes available for forecast', 403, 'NO_NODES');
  }

  if (nodeIds.length > 50) {
    throw new ApiError('A maximum of 50 node IDs is allowed per batch forecast request', 400, 'TOO_MANY_NODES');
  }

  const nodes = await EnergyNode.find({ _id: { $in: nodeIds } }).select('_id name');
  const nodeMap = new Map(nodes.map((n) => [n._id.toString(), n.name]));

  const missing = nodeIds.filter((id) => !nodeMap.has(id));
  if (missing.length > 0) {
    throw new ApiError('One or more nodes not found', 404, 'NODE_NOT_FOUND', { missingNodeIds: missing });
  }

  const useDummyData = forceDummy || await shouldUseDummyDataForNodes(nodeIds);

  const aiBody = {
    days_to_predict: daysToPredict,
    use_dummy_data: useDummyData,
    node_ids: nodeIds,
  };
  if (horizon) aiBody.horizon = horizon;
  if (modelScope) aiBody.model_scope = modelScope;

  let response;
  try {
    response = await callAiBatchForecast(aiBody);
  } catch (error) {
    throw new ApiError('AI service unavailable', 503, 'AI_UNAVAILABLE', isProduction ? null : error.message);
  }

  if (!response.ok) {
    const errorDetails = await safeUpstreamErrorDetails(response);
    throw new ApiError(
      'Error communicating with AI service',
      response.status,
      'AI_UPSTREAM_ERROR',
      errorDetails,
    );
  }

  const data = await response.json();
  const forecasts = (data.forecasts || []).map((entry) => ({
    nodeId: entry.node_id,
    nodeName: nodeMap.get(entry.node_id),
    predictions: entry.predictions,
    modelScope: entry.model_scope || null,
    horizon: entry.horizon || null,
  }));

  return {
    forecasts,
    modelStatus: data.model_status,
    useDummyData,
  };
}

const getForecast = asyncHandler(async (req, res) => {
  const daysToPredict = parseForecastDays(req.query.days);
  const forceDummy = req.query.useDummy === 'true';
  const nodeId = req.query.nodeId;
  const nodeIdsParam = req.query.nodeIds;
  const allNodes = req.query.allNodes === 'true';
  // Module 4.3.6 — native multi-horizon + per-node model resolution.
  const horizon = parseForecastHorizon(req.query.horizon);
  const modelScope = parseModelScope(req.query.modelScope);
  const privileged = isPrivileged(req.user);

  let nodeIds = parseNodeIdsParam(nodeIdsParam);

  if (allNodes || nodeIds.length > 0) {
    nodeIds = await resolveBatchNodeIds(req, { allNodes, nodeIdsParam: nodeIds.join(',') });

    const { forecasts, modelStatus, useDummyData } = await runBatchForecast({
      nodeIds,
      daysToPredict,
      forceDummy,
      horizon,
      modelScope,
    });

    return res.status(200).json({
      forecasts,
      model_status: modelStatus,
      warning: buildDummyWarning(useDummyData),
      meta: {
        useDummyData,
        daysToPredict,
        horizon,
        modelScope,
        nodeCount: forecasts.length,
        mode: 'multi',
      },
    });
  }

  if (nodeId) {
    if (!privileged) {
      await assertNodeOwnership(req.user._id, nodeId);
    }

    const node = await EnergyNode.findById(nodeId).select('_id name');
    if (!node) {
      return res.status(404).json({
        success: false,
        message: 'Node not found',
      });
    }

    const useDummyData = await shouldUseDummyData(forceDummy, nodeId);

    const aiBody = {
      days_to_predict: daysToPredict,
      use_dummy_data: useDummyData,
      node_id: nodeId,
    };
    if (horizon) aiBody.horizon = horizon;
    if (modelScope) aiBody.model_scope = modelScope;

    let response;
    try {
      response = await callAiForecast(aiBody);
    } catch (error) {
      return res.status(503).json({
        success: false,
        message: 'AI service unavailable',
        ...(!isProduction ? { details: error.message } : {}),
      });
    }

    if (!response.ok) {
      const errorDetails = await safeUpstreamErrorDetails(response);
      return res.status(response.status).json({
        success: false,
        message: 'Error communicating with AI service',
        ...(errorDetails ? { details: errorDetails } : {}),
      });
    }

    const data = await response.json();

    return res.status(200).json({
      ...data,
      nodeId,
      nodeName: node.name,
      warning: buildDummyWarning(useDummyData),
      meta: {
        useDummyData,
        daysToPredict,
        horizon,
        modelScope,
        nodeId,
        nodeName: node.name,
        mode: 'single',
      },
    });
  }

  if (!privileged) {
    const ownedNodeIds = await getOwnedNodeIds(req.user._id);
    const { forecasts, modelStatus, useDummyData } = await runBatchForecast({
      nodeIds: ownedNodeIds,
      daysToPredict,
      forceDummy,
      horizon,
      modelScope,
    });

    const predictions = mergeForecastPredictions(forecasts);

    return res.status(200).json({
      predictions,
      model_status: modelStatus,
      warning: buildDummyWarning(useDummyData),
      meta: {
        useDummyData,
        daysToPredict,
        horizon,
        modelScope,
        nodeCount: forecasts.length,
        mode: 'aggregate',
        scopedToUser: true,
      },
    });
  }

  const useDummyData = await shouldUseDummyData(forceDummy);

  const aggregateAiBody = {
    days_to_predict: daysToPredict,
    use_dummy_data: useDummyData,
  };
  if (horizon) aggregateAiBody.horizon = horizon;
  if (modelScope) aggregateAiBody.model_scope = modelScope;

  let response;
  try {
    response = await callAiForecast(aggregateAiBody);
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: 'AI service unavailable',
      ...(!isProduction ? { details: error.message } : {}),
    });
  }

  if (!response.ok) {
    const errorDetails = await safeUpstreamErrorDetails(response);
    return res.status(response.status).json({
      success: false,
      message: 'Error communicating with AI service',
      ...(errorDetails ? { details: errorDetails } : {}),
    });
  }

  const data = await response.json();

  res.status(200).json({
    ...data,
    warning: buildDummyWarning(useDummyData),
    meta: {
      useDummyData,
      daysToPredict,
      horizon,
      modelScope,
      mode: 'aggregate',
    },
  });
});

const getForecastConfidence = asyncHandler(async (req, res) => {
  const modelVersion = req.query.model_version;

  if (modelVersion !== undefined && modelVersion !== null && modelVersion !== '') {
    if (!VERSION_PARAM_RE.test(String(modelVersion))) {
      throw new ApiError(
        'model_version must be alphanumeric, underscore or hyphen (max 64 chars)',
        400,
        'INVALID_MODEL_VERSION',
      );
    }
  }

  let response;
  try {
    response = await callAiConfidence(modelVersion || undefined);
  } catch (error) {
    throw new ApiError('AI service unavailable', 503, 'AI_UNAVAILABLE');
  }

  if (!response.ok) {
    const details = await safeUpstreamErrorDetails(response);
    throw new ApiError(
      'Error communicating with AI service',
      response.status,
      'AI_UPSTREAM_ERROR',
      details,
    );
  }

  const data = await response.json();
  return res.status(200).json({ success: true, data });
});

module.exports = {
  getForecast,
  getForecastConfidence,
};
