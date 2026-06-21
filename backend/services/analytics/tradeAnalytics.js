const Trade = require('../../models/Trade');
const { getRedisClient, isRedisAvailable } = require('../../config/redis');

const ACTIVE_LISTING_COUNT_KEY = 'analytics:active_listing_count';
const getActiveListingCountTtl = () => {
  const parsed = parseInt(process.env.ACTIVE_LISTING_COUNT_CACHE_SECONDS || '60', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
};

let activeListingCountMemory = { at: 0, value: 0 };

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
  const now = Date.now();
  if (now - activeListingCountMemory.at < getActiveListingCountTtl() * 1000) {
    return activeListingCountMemory.value;
  }

  if (isRedisAvailable()) {
    try {
      const cached = await getRedisClient().get(ACTIVE_LISTING_COUNT_KEY);
      if (cached !== null) {
        const value = parseInt(cached, 10) || 0;
        activeListingCountMemory = { at: now, value };
        return value;
      }
    } catch {
      // fall through
    }
  }

  const [row] = await Trade.aggregate([
    { $sort: { listingId: 1, blockTimestamp: -1, blockNumber: -1 } },
    { $group: { _id: '$listingId', lastEvent: { $first: '$eventType' } } },
    { $match: { lastEvent: 'listed' } },
    { $count: 'active' },
  ]);

  const value = row?.active || 0;
  activeListingCountMemory = { at: now, value };

  if (isRedisAvailable()) {
    try {
      await getRedisClient().set(
        ACTIVE_LISTING_COUNT_KEY,
        String(value),
        'EX',
        getActiveListingCountTtl(),
      );
    } catch {
      // best-effort
    }
  }

  return value;
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

  const historyCap = parseInt(process.env.WALLET_FLOW_HISTORY_CAP || '90', 10);
  const safeCap = Number.isFinite(historyCap) && historyCap > 0 ? historyCap : 90;

  const [statsRows, historyRows] = await Promise.all([
    Trade.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          creditsReceived: {
            $sum: {
              $cond: [{ $eq: ['$seller', wallet] }, { $toDouble: '$price' }, 0],
            },
          },
          creditsSpent: {
            $sum: {
              $cond: [{ $eq: ['$buyer', wallet] }, { $toDouble: '$price' }, 0],
            },
          },
          saleCount: {
            $sum: {
              $cond: [{ $eq: ['$seller', wallet] }, 1, 0],
            },
          },
          purchaseCount: {
            $sum: {
              $cond: [{ $eq: ['$buyer', wallet] }, 1, 0],
            },
          },
        },
      },
    ]),
    Trade.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$blockTimestamp' } },
          received: {
            $sum: {
              $cond: [{ $eq: ['$seller', wallet] }, { $toDouble: '$price' }, 0],
            },
          },
          spent: {
            $sum: {
              $cond: [{ $eq: ['$buyer', wallet] }, { $toDouble: '$price' }, 0],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: safeCap },
    ]),
  ]);

  const stats = statsRows[0] || {};
  const creditsReceived = stats.creditsReceived || 0;
  const creditsSpent = stats.creditsSpent || 0;
  const saleCount = stats.saleCount || 0;
  const purchaseCount = stats.purchaseCount || 0;

  let cumulativeNet = 0;
  const historyWithCumulative = historyRows.map((row) => {
    const net = (row.received || 0) - (row.spent || 0);
    cumulativeNet += net;
    return {
      date: row._id,
      received: row.received || 0,
      spent: row.spent || 0,
      net,
      cumulativeNet,
    };
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
