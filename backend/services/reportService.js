const { getEnergyTotals } = require('./analytics/energyAnalytics');
const { getTradeStats, getPlatformVolumeByDay } = require('./analytics/tradeAnalytics');
const { getNodeStats } = require('./analytics/nodeAnalytics');

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

module.exports = { buildGridEnergySection, buildGridTradingSection, buildNodeOverviewSection };
