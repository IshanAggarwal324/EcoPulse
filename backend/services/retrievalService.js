const { getEnergyTotals } = require('./analytics/energyAnalytics');
const { getTradeStats, getPlatformVolumeByDay, getWalletFlowHistory } = require('./analytics/tradeAnalytics');
const { getNodeStats } = require('./analytics/nodeAnalytics');
const { getCarbonStats } = require('./analytics/carbonAnalytics');
const { parsePeriod } = require('../utils/periodHelpers');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

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
      { type: 'analytics', label: `Grid energy totals (${label})`, endpoint: '/analytics/energy' },
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
      { type: 'analytics', label: `Wallet flow history (${label})`, endpoint: '/analytics/trades' },
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
      { type: 'analytics', label: 'Carbon credit stats', endpoint: '/analytics/carbon' },
    ],
  };
}

async function retrieveTrades(period) {
  const parsed = parsePeriod(period || '7d');
  const since = parsed ? parsed.sinceDate : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const label = parsed ? parsed.label : 'Last 7 days';

  const [stats, dailyVolume] = await Promise.all([
    getTradeStats(),
    getPlatformVolumeByDay(since),
  ]);

  return {
    retrieved_data: {
      completedTrades: stats.completedTrades,
      totalEnergyTraded: stats.totalEnergyTraded,
      totalVolumeCredits: stats.totalVolumeCredits,
      totalListings: stats.totalListings,
      cancelledListings: stats.cancelledListings,
      dailyVolume: Array.isArray(dailyVolume) ? dailyVolume.slice(-30) : dailyVolume,
      period: label,
    },
    sources: [
      { type: 'analytics', label: `Trade stats (${label})`, endpoint: '/analytics/trades' },
    ],
  };
}

async function retrieveForecast() {
  let forecastData = null;
  let available = false;

  try {
    const response = await fetch(`${AI_SERVICE_URL}/forecast/?days=7`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json();
      forecastData = {
        predictions: data.predictions || null,
        modelStatus: data.model_status || null,
        daysToPredict: data.meta?.daysToPredict || 7,
        mode: data.meta?.mode || 'aggregate',
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
      { type: 'forecast', label: '7-day LSTM energy forecast', endpoint: '/forecast?days=7' },
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
      { type: 'analytics', label: 'Node overview', endpoint: '/analytics/nodes' },
    ],
  };
}

const INTENT_RETRIEVER_MAP = {
  grid_energy: (ctx) => retrieveGridEnergy(ctx.period),
  wallet_profit: (ctx) => retrieveWalletProfit(ctx.walletAddress, ctx.period),
  carbon: (ctx) => retrieveCarbon(ctx.walletAddress),
  trades: (ctx) => retrieveTrades(ctx.period),
  forecast: () => retrieveForecast(),
  nodes: () => retrieveNodes(),
};

async function retrieveForIntent(intent, { walletAddress = null, period = null } = {}) {
  const ctx = { walletAddress, period };
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
