const EnergyReading = require('../models/EnergyReading');
const { getEnergyTotals } = require('./analytics/energyAnalytics');
const { getTradeStats, getPlatformVolumeByDay, getWalletFlowHistory } = require('./analytics/tradeAnalytics');
const { getNodeStats } = require('./analytics/nodeAnalytics');
const { getCarbonStats } = require('./analytics/carbonAnalytics');
const { parsePeriod } = require('../utils/periodHelpers');

async function buildGridEnergySection(since) {
  const { totalGenerated, totalConsumed, readingCount } = await getEnergyTotals(since);

  return {
    totalGenerated,
    totalConsumed,
    netEnergy: totalGenerated - totalConsumed,
    readingCount,
  };
}

async function buildGridTradingSection(since) {
  const [stats, dailyVolume] = await Promise.all([
    getTradeStats(),
    getPlatformVolumeByDay(since),
  ]);

  return {
    completedTrades: stats.completedTrades,
    totalEnergyTraded: stats.totalEnergyTraded,
    totalVolumeCredits: stats.totalVolumeCredits,
    totalListings: stats.totalListings,
    cancelledListings: stats.cancelledListings,
    dailyVolume,
  };
}

async function buildNodeOverviewSection() {
  const { activeNodes, totalNodes, byStatus } = await getNodeStats();

  return {
    activeNodes,
    totalNodes,
    byStatus,
  };
}

async function buildPersonalProfitSection(walletAddress, since) {
  if (!walletAddress) return null;

  const {
    creditsReceived,
    creditsSpent,
    netFlow,
    saleCount,
    purchaseCount,
    history,
  } = await getWalletFlowHistory(walletAddress, since);

  return {
    creditsReceived,
    creditsSpent,
    netFlow,
    saleCount,
    purchaseCount,
    dailyHistory: history,
  };
}

async function buildCarbonSection(walletAddress) {
  if (!walletAddress) return null;

  const {
    totalCreditsTraded,
    completedTrades,
    walletBalance,
    estimatedGridCredits,
    balanceAnalytics,
  } = await getCarbonStats(walletAddress);

  return {
    totalCreditsTraded,
    completedTrades,
    walletBalance,
    estimatedGridCredits,
    walletNetFlow: balanceAnalytics?.wallet?.netFlow ?? null,
  };
}

async function buildReportMeta({ period, scope, walletAddress }) {
  const readingCount = await EnergyReading.countDocuments();
  const isDemoData = readingCount < 30 && process.env.NODE_ENV !== 'production';

  return {
    isDemoData,
    period,
    scope,
    generatedAt: new Date().toISOString(),
    walletConnected: !!walletAddress,
  };
}

function filterByScope(metrics, scope) {
  const result = { ...metrics };

  if (scope === 'grid') {
    delete result.personalEnergy;
    delete result.personalProfit;
    delete result.carbon;
  } else if (scope === 'personal') {
    delete result.gridEnergy;
    delete result.gridTrading;
    delete result.nodeOverview;
  }

  return result;
}

function truncateDailyVolume(rows, maxDays = 30) {
  if (!Array.isArray(rows)) return rows;
  if (rows.length <= maxDays) return rows;
  return rows.slice(rows.length - maxDays);
}

async function buildReportMetrics({ period, walletAddress, scope = 'both' }) {
  const parsed = parsePeriod(period);
  if (!parsed) throw new Error(`Invalid period: ${period}`);

  const { sinceDate, label } = parsed;

  const [gridEnergy, gridTrading, nodeOverview, personalProfit, carbon, meta] = await Promise.all([
    buildGridEnergySection(sinceDate),
    buildGridTradingSection(sinceDate),
    buildNodeOverviewSection(),
    buildPersonalProfitSection(walletAddress, sinceDate),
    buildCarbonSection(walletAddress),
    buildReportMeta({ period, scope, walletAddress }),
  ]);

  if (gridTrading.dailyVolume) {
    gridTrading.dailyVolume = truncateDailyVolume(gridTrading.dailyVolume);
  }
  if (personalProfit?.dailyHistory) {
    personalProfit.dailyHistory = truncateDailyVolume(personalProfit.dailyHistory);
  }

  const metrics = filterByScope({
    gridEnergy,
    gridTrading,
    nodeOverview,
    personalProfit,
    carbon,
    periodLabel: label,
  }, scope);

  return { ...metrics, meta };
}

module.exports = {
  buildGridEnergySection,
  buildGridTradingSection,
  buildNodeOverviewSection,
  buildPersonalProfitSection,
  buildCarbonSection,
  buildReportMeta,
  filterByScope,
  truncateDailyVolume,
  buildReportMetrics,
};
