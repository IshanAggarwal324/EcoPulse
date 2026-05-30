const EnergyReading = require('../models/EnergyReading');
const EnergyNode = require('../models/EnergyNode');
const Trade = require('../models/Trade');

const parsePrice = (price) => {
  const value = parseFloat(price);
  return Number.isFinite(value) ? value : 0;
};

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
  const [purchases, listedCount, cancelledCount] = await Promise.all([
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
    Trade.countDocuments({ eventType: 'cancelled' }),
  ]);

  const purchaseStats = purchases[0] || {};

  return {
    completedTrades: purchaseStats.completedTrades || 0,
    totalEnergyTraded: purchaseStats.totalEnergyTraded || 0,
    totalVolumeCredits: purchaseStats.totalVolume || 0,
    totalListings: listedCount,
    cancelledListings: cancelledCount,
  };
};

const getPlatformVolumeByDay = async (since) => {
  const match = {
    eventType: 'purchased',
    ...(since ? { blockTimestamp: { $gte: since } } : {}),
  };

  const rows = await Trade.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$blockTimestamp' },
        },
        volume: { $sum: { $toDouble: '$price' } },
        tradeCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((row) => ({
    date: row._id,
    volume: row.volume || 0,
    tradeCount: row.tradeCount || 0,
  }));
};

const getUniqueTraderCount = async () => {
  const [sellers, buyers] = await Promise.all([
    Trade.distinct('seller', { eventType: 'purchased' }),
    Trade.distinct('buyer', { eventType: 'purchased', buyer: { $ne: null } }),
  ]);
  return new Set([...sellers, ...buyers.filter(Boolean)]).size;
};

const getWalletFlowHistory = async (walletAddress, since) => {
  const wallet = walletAddress.toLowerCase();
  const match = {
    eventType: 'purchased',
    $or: [{ seller: wallet }, { buyer: wallet }],
    ...(since ? { blockTimestamp: { $gte: since } } : {}),
  };

  const trades = await Trade.find(match).sort({ blockTimestamp: 1 }).lean();
  const dayMap = new Map();

  let creditsReceived = 0;
  let creditsSpent = 0;
  let saleCount = 0;
  let purchaseCount = 0;

  trades.forEach((trade) => {
    const price = parsePrice(trade.price);
    const day = trade.blockTimestamp
      ? new Date(trade.blockTimestamp).toISOString().slice(0, 10)
      : 'unknown';

    if (!dayMap.has(day)) {
      dayMap.set(day, { date: day, received: 0, spent: 0, net: 0 });
    }
    const entry = dayMap.get(day);

    if (trade.seller === wallet) {
      creditsReceived += price;
      entry.received += price;
      saleCount += 1;
    }
    if (trade.buyer === wallet) {
      creditsSpent += price;
      entry.spent += price;
      purchaseCount += 1;
    }
    entry.net = entry.received - entry.spent;
  });

  const history = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  let cumulativeNet = 0;
  const historyWithCumulative = history.map((row) => {
    cumulativeNet += row.net;
    return { ...row, cumulativeNet };
  });

  return {
    creditsReceived,
    creditsSpent,
    netFlow: creditsReceived - creditsSpent,
    saleCount,
    purchaseCount,
    history: historyWithCumulative,
  };
};

const getOnChainWalletBalances = async (walletAddress) => {
  try {
    const BlockchainService = require('./blockchainService');
    const [balance, allowance] = await Promise.all([
      BlockchainService.getBalance(walletAddress),
      BlockchainService.getAllowance(walletAddress),
    ]);
    return { balance, allowance };
  } catch {
    return { balance: null, allowance: null };
  }
};

const getCarbonBalanceAnalytics = async (walletAddress, days = 30) => {
  const since = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

  const [platformVolumeByDay, tradeStats, uniqueTraders, walletFlows] = await Promise.all([
    getPlatformVolumeByDay(since),
    getTradeStats(),
    getUniqueTraderCount(),
    walletAddress ? getWalletFlowHistory(walletAddress, since) : null,
  ]);

  let wallet = null;
  if (walletAddress) {
    const onChain = await getOnChainWalletBalances(walletAddress);
    const balanceNum = parsePrice(onChain.balance);
    const allowanceNum = parsePrice(onChain.allowance);

    wallet = {
      address: walletAddress,
      balance: onChain.balance,
      allowance: onChain.allowance,
      unapprovedBalance: Math.max(0, balanceNum - allowanceNum),
      creditsReceived: walletFlows?.creditsReceived || 0,
      creditsSpent: walletFlows?.creditsSpent || 0,
      netFlow: walletFlows?.netFlow || 0,
      saleCount: walletFlows?.saleCount || 0,
      purchaseCount: walletFlows?.purchaseCount || 0,
      history: walletFlows?.history || [],
    };
  }

  let totalSupply = null;
  try {
    const BlockchainService = require('./blockchainService');
    totalSupply = await BlockchainService.getTotalSupply();
  } catch {
    totalSupply = null;
  }

  return {
    periodDays: days,
    wallet,
    platform: {
      totalCreditsTraded: tradeStats.totalVolumeCredits,
      completedTrades: tradeStats.completedTrades,
      totalSupply,
      uniqueTraders,
      volumeByDay: platformVolumeByDay,
    },
  };
};

const getCarbonStats = async (walletAddress) => {
  const tradeStats = await getTradeStats();
  const balanceAnalytics = await getCarbonBalanceAnalytics(walletAddress, 30);

  let walletBalance = balanceAnalytics.wallet?.balance ?? null;
  if (!walletBalance && walletAddress) {
    const onChain = await getOnChainWalletBalances(walletAddress);
    walletBalance = onChain.balance;
  }

  return {
    totalCreditsTraded: tradeStats.totalVolumeCredits,
    completedTrades: tradeStats.completedTrades,
    walletBalance,
    estimatedGridCredits: Math.round(tradeStats.totalVolumeCredits + tradeStats.totalEnergyTraded * 0.1),
    balanceAnalytics,
  };
};

const getRecentReadings = async (limit = 20) => {
  return EnergyReading.find()
    .sort({ timestamp: -1 })
    .limit(limit)
    .populate('nodeId', 'name nodeType sourceType status')
    .lean();
};

/** Lightweight aggregates for high-frequency socket updates (no carbon / recent readings). */
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
  getRealtimeSnapshot,
  getEnergyTotals,
  getNodeStats,
  getTradeStats,
  getCarbonStats,
  getCarbonBalanceAnalytics,
  getRecentReadings,
};
