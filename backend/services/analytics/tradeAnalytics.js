const Trade = require('../../models/Trade');

const parsePrice = (price) => {
  const value = parseFloat(price);
  return Number.isFinite(value) ? value : 0;
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

/**
 * Approximate count of currently-active listings, derived from the on-chain
 * event log. A listing is active when its most recent event is still `listed`
 * (i.e. it has not subsequently been purchased or cancelled). This avoids a
 * live contract read so the assistant path stays offline-friendly.
 */
const getActiveListingCount = async () => {
  const [row] = await Trade.aggregate([
    { $sort: { blockTimestamp: 1 } },
    { $group: { _id: '$listingId', lastEvent: { $last: '$eventType' } } },
    { $match: { lastEvent: 'listed' } },
    { $count: 'active' },
  ]);
  return row?.active || 0;
};

/**
 * Daily average unit price (CC per kWh) for completed purchases since `since`.
 * Used to show the assistant a compact price trend instead of raw trade rows.
 */
const getUnitPriceTrend = async (since) => {
  const match = {
    eventType: 'purchased',
    energyAmount: { $gt: 0 },
    ...(since ? { blockTimestamp: { $gte: since } } : {}),
  };

  const rows = await Trade.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$blockTimestamp' } },
        avgUnitPrice: {
          $avg: { $divide: [{ $toDouble: '$price' }, '$energyAmount'] },
        },
        trades: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows
    .slice(-14)
    .map((row) => ({
      date: row._id,
      avgUnitPriceCc: Number((row.avgUnitPrice || 0).toFixed(4)),
      trades: row.trades || 0,
    }));
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

module.exports = {
  getTradeStats,
  getPlatformVolumeByDay,
  getUniqueTraderCount,
  getActiveListingCount,
  getUnitPriceTrend,
  getWalletFlowHistory,
  parsePrice,
};
