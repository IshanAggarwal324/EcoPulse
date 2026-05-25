const EnergyReading = require('../models/EnergyReading');
const EnergyNode = require('../models/EnergyNode');
const Trade = require('../models/Trade');

const getEnergyTotals = async (since) => {
  const match = since ? { timestamp: { $gte: since } } : {};

  const [result] = await EnergyReading.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalGenerated: { $sum: '$energyGenerated' },
        totalConsumed: { $sum: '$energyConsumed' },
        readingCount: { $sum: 1 },
      },
    },
  ]);

  return {
    totalGenerated: result?.totalGenerated || 0,
    totalConsumed: result?.totalConsumed || 0,
    readingCount: result?.readingCount || 0,
  };
};

const getNodeStats = async () => {
  const [statusBreakdown, activeNodes, totalNodes] = await Promise.all([
    EnergyNode.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    EnergyNode.countDocuments({ status: 'active' }),
    EnergyNode.countDocuments(),
  ]);

  const byStatus = statusBreakdown.reduce((acc, item) => {
    acc[item._id] = item.count;
    return acc;
  }, {});

  return { activeNodes, totalNodes, byStatus };
};

const getTradeStats = async () => {
  const [purchases, listings] = await Promise.all([
    Trade.aggregate([
      { $match: { eventType: 'purchased' } },
      {
        $group: {
          _id: null,
          completedTrades: { $sum: 1 },
          totalEnergyTraded: { $sum: '$energyAmount' },
          totalVolume: {
            $sum: { $toDouble: '$price' },
          },
        },
      },
    ]),
    Trade.countDocuments({ eventType: 'listed' }),
  ]);

  const purchaseStats = purchases[0] || {};

  return {
    completedTrades: purchaseStats.completedTrades || 0,
    totalEnergyTraded: purchaseStats.totalEnergyTraded || 0,
    totalVolumeCredits: purchaseStats.totalVolume || 0,
    totalListings: listings,
  };
};

const getCarbonStats = async (walletAddress) => {
  const tradeStats = await getTradeStats();

  let walletBalance = null;
  if (walletAddress) {
    try {
      const BlockchainService = require('./blockchainService');
      walletBalance = await BlockchainService.getBalance(walletAddress);
    } catch {
      walletBalance = null;
    }
  }

  return {
    totalCreditsTraded: tradeStats.totalVolumeCredits,
    completedTrades: tradeStats.completedTrades,
    walletBalance,
    estimatedGridCredits: Math.round(tradeStats.totalVolumeCredits + tradeStats.totalEnergyTraded * 0.1),
  };
};

const getRecentReadings = async (limit = 20) => {
  return EnergyReading.find()
    .sort({ timestamp: -1 })
    .limit(limit)
    .populate('nodeId', 'name nodeType sourceType status')
    .lean();
};

const getSummary = async (options = {}) => {
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

module.exports = {
  getSummary,
  getEnergyTotals,
  getNodeStats,
  getTradeStats,
  getCarbonStats,
  getRecentReadings,
};
