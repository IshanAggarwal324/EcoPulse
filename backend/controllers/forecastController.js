const EnergyReading = require('../models/EnergyReading');
const EnergyNode = require('../models/EnergyNode');
const asyncHandler = require('../utils/asyncHandler');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

async function callAiForecast(body) {
  const response = await fetch(`${AI_SERVICE_URL}/forecast/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response;
}

async function callAiBatchForecast(body) {
  const response = await fetch(`${AI_SERVICE_URL}/forecast/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response;
}

async function shouldUseDummyData(forceDummy, nodeId = null) {
  if (forceDummy) return true;
  const query = nodeId ? { nodeId } : {};
  const readingCount = await EnergyReading.countDocuments(query);
  return readingCount < 30;
}

function parseNodeIdsParam(nodeIdsParam) {
  if (!nodeIdsParam) return [];
  return nodeIdsParam
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

const getForecast = asyncHandler(async (req, res) => {
  const daysToPredict = parseInt(req.query.days || '7', 10);
  const forceDummy = req.query.useDummy === 'true';
  const nodeId = req.query.nodeId;
  const nodeIdsParam = req.query.nodeIds;
  const allNodes = req.query.allNodes === 'true';

  let nodeIds = parseNodeIdsParam(nodeIdsParam);

  if (allNodes) {
    const nodes = await EnergyNode.find().select('_id name');
    nodeIds = nodes.map((n) => n._id.toString());
  }

  // Multi-node batch forecast
  if (nodeIds.length > 0) {
    const nodes = await EnergyNode.find({ _id: { $in: nodeIds } }).select('_id name');
    const nodeMap = new Map(nodes.map((n) => [n._id.toString(), n.name]));

    const missing = nodeIds.filter((id) => !nodeMap.has(id));
    if (missing.length > 0) {
      return res.status(404).json({
        success: false,
        message: 'One or more nodes not found',
        missingNodeIds: missing,
      });
    }

    const useDummyData = await shouldUseDummyData(forceDummy);

    let response;
    try {
      response = await callAiBatchForecast({
        days_to_predict: daysToPredict,
        use_dummy_data: useDummyData,
        node_ids: nodeIds,
      });
    } catch (error) {
      return res.status(503).json({
        success: false,
        message: 'AI service unavailable',
        details: error.message,
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        success: false,
        message: 'Error communicating with AI service',
        details: errorText,
      });
    }

    const data = await response.json();

    const forecasts = (data.forecasts || []).map((entry) => ({
      nodeId: entry.node_id,
      nodeName: nodeMap.get(entry.node_id),
      predictions: entry.predictions,
    }));

    return res.status(200).json({
      forecasts,
      model_status: data.model_status,
      meta: {
        useDummyData,
        daysToPredict,
        nodeCount: forecasts.length,
        mode: 'multi',
      },
    });
  }

  // Single-node forecast
  if (nodeId) {
    const node = await EnergyNode.findById(nodeId).select('_id name');
    if (!node) {
      return res.status(404).json({
        success: false,
        message: 'Node not found',
      });
    }

    const useDummyData = await shouldUseDummyData(forceDummy, nodeId);

    let response;
    try {
      response = await callAiForecast({
        days_to_predict: daysToPredict,
        use_dummy_data: useDummyData,
        node_id: nodeId,
      });
    } catch (error) {
      return res.status(503).json({
        success: false,
        message: 'AI service unavailable',
        details: error.message,
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        success: false,
        message: 'Error communicating with AI service',
        details: errorText,
      });
    }

    const data = await response.json();

    return res.status(200).json({
      ...data,
      nodeId,
      nodeName: node.name,
      meta: {
        useDummyData,
        daysToPredict,
        nodeId,
        nodeName: node.name,
        mode: 'single',
      },
    });
  }

  // Network aggregate forecast (all readings combined)
  const useDummyData = await shouldUseDummyData(forceDummy);

  let response;
  try {
    response = await callAiForecast({
      days_to_predict: daysToPredict,
      use_dummy_data: useDummyData,
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: 'AI service unavailable',
      details: error.message,
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    return res.status(response.status).json({
      success: false,
      message: 'Error communicating with AI service',
      details: errorText,
    });
  }

  const data = await response.json();

  res.status(200).json({
    ...data,
    meta: {
      useDummyData,
      daysToPredict,
      mode: 'aggregate',
    },
  });
});

module.exports = {
  getForecast,
};
