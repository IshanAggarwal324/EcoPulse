const { getEnergyTotals, getRecentReadings } = require('./energyAnalytics');
const { getNodeStats } = require('./nodeAnalytics');
const {
  getTradeStats,
  getPlatformVolumeByDay,
  getUniqueTraderCount,
  getWalletFlowHistory,
} = require('./tradeAnalytics');
const { getCarbonStats, getCarbonBalanceAnalytics } = require('./carbonAnalytics');
const { getSummary, getRealtimeSnapshot } = require('./summaryService');

module.exports = {
  getSummary,
  getRealtimeSnapshot,
  getEnergyTotals,
  getNodeStats,
  getTradeStats,
  getCarbonStats,
  getCarbonBalanceAnalytics,
  getRecentReadings,
  getPlatformVolumeByDay,
  getUniqueTraderCount,
  getWalletFlowHistory,
};
