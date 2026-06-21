const { getEnergyTotals, getRecentReadings } = require('./energyAnalytics');
const { getNodeStats } = require('./nodeAnalytics');
const { getTradeStats } = require('./tradeAnalytics');
const { getCarbonStats } = require('./carbonAnalytics');
const { getCachedSummary } = require('./summaryCache');

const buildSummary = async (options = {}) => {
  const { walletAddress, sinceHours } = options;
  const since = sinceHours
    ? new Date(Date.now() - sinceHours * 60 * 60 * 1000)
    : null;

  const [energy, nodes, trades, carbon, recentReadings] = await Promise.all([
    getEnergyTotals(since),
    getNodeStats(),
    getTradeStats(),
    getCarbonStats(walletAddress),
    getRecentReadings(20),
  ]);

  return {
    energy,
    nodes,
    trades,
    carbon,
    recentReadings,
    syncedAt: new Date().toISOString(),
    periodHours: sinceHours || null,
  };
};

const getSummary = async (options = {}) => {
  const { walletAddress, sinceHours } = options;
  return getCachedSummary(walletAddress, sinceHours, () => buildSummary(options));
};

const getRealtimeSnapshot = async () => {
  const [energy, nodes, trades] = await Promise.all([
    getEnergyTotals(),
    getNodeStats(),
    getTradeStats(),
  ]);

  return {
    energy,
    nodes,
    trades,
    syncedAt: new Date().toISOString(),
  };
};

module.exports = { getSummary, getRealtimeSnapshot };
