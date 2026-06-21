const { getEnergyTotals } = require('./analytics/energyAnalytics');
const { getTradeStats, getPlatformVolumeByDay, getActiveListingCount, getUnitPriceTrend } = require('./analytics/tradeAnalytics');
const { getNodeStats } = require('./analytics/nodeAnalytics');
const { getCarbonStats } = require('./analytics/carbonAnalytics');
const { parsePeriod } = require('../utils/periodHelpers');
const {
  retrieveRecentReadings,
  retrieveBillAnalysis,
  retrieveUserNodes,
} = require('./assistantRetrievers');

const { getAiServiceUrl } = require('../config/serviceUrls');

const AI_SERVICE_URL = getAiServiceUrl();
const INTERNAL_SERVICE_API_KEY = process.env.INTERNAL_SERVICE_API_KEY || '';

function buildInternalHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(INTERNAL_SERVICE_API_KEY ? { 'x-internal-api-key': INTERNAL_SERVICE_API_KEY } : {}),
  };
}

async function retrieveGridEnergy(period) {
  const parsed = parsePeriod(period || '7d');
  const since = parsed ? parsed.sinceDate : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const label = parsed ? parsed.label : 'Last 7 days';

  const { totalGenerated, totalConsumed, readingCount } = await getEnergyTotals(since);

  return {
    retrieved_data: {
      totalGenerated,
      totalConsumed,
      netEnergy: totalGenerated - totalConsumed,
      readingCount,
      period: label,
    },
    sources: [
      { type: 'reading', label: `Grid energy totals (${label})`, endpoint: '/analytics/energy' },
    ],
  };
}

async function retrieveWalletProfit(walletAddress, period) {
  if (!walletAddress) {
    return {
      retrieved_data: { walletConnected: false, explanation: 'No wallet connected. Personal profit data is unavailable.' },
      sources: [],
    };
  }

  const parsed = parsePeriod(period || '7d');
  const since = parsed ? parsed.sinceDate : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const label = parsed ? parsed.label : 'Last 7 days';

  const {
    creditsReceived,
    creditsSpent,
    netFlow,
    saleCount,
    purchaseCount,
  } = await getWalletFlowHistory(walletAddress, since);

  return {
    retrieved_data: {
      walletConnected: true,
      creditsReceived,
      creditsSpent,
      netFlow,
      saleCount,
      purchaseCount,
      period: label,
    },
    sources: [
      { type: 'wallet', label: `Wallet flow history (${label})`, endpoint: '/analytics/trades' },
    ],
  };
}

async function retrieveCarbon(walletAddress) {
  if (!walletAddress) {
    return {
      retrieved_data: { walletConnected: false, explanation: 'No wallet connected. Carbon credit data is unavailable.' },
      sources: [],
    };
  }

  const {
    totalCreditsTraded,
    completedTrades,
    walletBalance,
    estimatedGridCredits,
    balanceAnalytics,
  } = await getCarbonStats(walletAddress);

  return {
    retrieved_data: {
      walletConnected: true,
      totalCreditsTraded,
      completedTrades,
      walletBalance,
      estimatedGridCredits,
      walletNetFlow: balanceAnalytics?.wallet?.netFlow ?? null,
    },
    sources: [
      { type: 'carbon', label: 'Carbon credit stats', endpoint: '/analytics/carbon' },
    ],
  };
}

async function retrieveTrades(period) {
  const parsed = parsePeriod(period || '7d');
  const since = parsed ? parsed.sinceDate : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const label = parsed ? parsed.label : 'Last 7 days';

  const [stats, dailyVolume, activeListings, unitPriceTrend] = await Promise.all([
    getTradeStats(),
    getPlatformVolumeByDay(since),
    getActiveListingCount(),
    getUnitPriceTrend(since),
  ]);

  return {
    retrieved_data: {
      completedTrades: stats.completedTrades,
      totalEnergyTraded: stats.totalEnergyTraded,
      totalVolumeCredits: stats.totalVolumeCredits,
      totalListings: stats.totalListings,
      cancelledListings: stats.cancelledListings,
      activeListings,
      unitPriceTrend,
      dailyVolume: Array.isArray(dailyVolume) ? dailyVolume.slice(-30) : dailyVolume,
      period: label,
    },
    sources: [
      { type: 'trade', label: `Trade stats (${label})`, endpoint: '/analytics/trades' },
    ],
  };
}

// Sub-module 3.2.1/3.2.2 — forecast retrieval must POST to the AI service
// `/forecast/` endpoint (matching forecastController.js). The previous GET
// request always 404'd against the POST-only route. Supports an optional
// per-node forecast via `nodeId`.
async function retrieveForecast({ nodeId = null } = {}) {
  let forecastData = null;
  let available = false;

  try {
    const body = { days_to_predict: 7, use_dummy_data: false };
    if (nodeId) body.node_id = nodeId;

    const response = await fetch(`${AI_SERVICE_URL}/forecast/`, {
      method: 'POST',
      headers: buildInternalHeaders(),
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = await response.json();
      forecastData = {
        predictions: data.predictions || null,
        modelStatus: data.model_status || null,
        daysToPredict: data.meta?.daysToPredict || 7,
        mode: data.meta?.mode || (nodeId ? 'single' : 'aggregate'),
        nodeName: data.nodeName || null,
      };
      available = true;
    }
  } catch (_) {
    // AI service unavailable
  }

  return {
    retrieved_data: {
      available,
      forecast: forecastData,
      explanation: available ? null : 'Forecast service is currently unavailable.',
    },
    sources: [
      { type: 'forecast', label: nodeId ? '7-day node forecast' : '7-day LSTM energy forecast', endpoint: '/forecast/' },
    ],
  };
}

async function retrieveNodes() {
  const { activeNodes, totalNodes, byStatus } = await getNodeStats();

  return {
    retrieved_data: {
      activeNodes,
      totalNodes,
      byStatus,
    },
    sources: [
      { type: 'nodes', label: 'Node overview', endpoint: '/analytics/nodes' },
    ],
  };
}

const INTENT_RETRIEVER_MAP = {
  grid_energy: (ctx) => retrieveGridEnergy(ctx.period),
  wallet_profit: (ctx) => retrieveWalletProfit(ctx.walletAddress, ctx.period),
  carbon: (ctx) => retrieveCarbon(ctx.walletAddress),
  trades: (ctx) => retrieveTrades(ctx.period),
  forecast: (ctx) => retrieveForecast({ nodeId: ctx.nodeId }),
  nodes: (ctx) => retrieveUserNodes(ctx.userId),
  bill_analysis: (ctx) => retrieveBillAnalysis(ctx.userId, ctx.period),
  node_detail: (ctx) => retrieveRecentReadings(ctx.userId, ctx.nodeId),
};

async function retrieveForIntent(
  intent,
  { walletAddress = null, period = null, userId = null, nodeId = null, message = null } = {},
) {
  const ctx = { walletAddress, period, userId, nodeId, message };
  const retriever = INTENT_RETRIEVER_MAP[intent];

  if (!retriever) {
    return {
      retrieved_data: { intent: 'general', explanation: 'No structured data retrieved for this query.' },
      sources: [],
    };
  }

  try {
    return await retriever(ctx);
  } catch (error) {
    return {
      retrieved_data: { intent, error: error.message, explanation: 'Failed to retrieve data for this query.' },
      sources: [],
    };
  }
}

module.exports = {
  retrieveGridEnergy,
  retrieveWalletProfit,
  retrieveCarbon,
  retrieveTrades,
  retrieveForecast,
  retrieveNodes,
  retrieveForIntent,
};
