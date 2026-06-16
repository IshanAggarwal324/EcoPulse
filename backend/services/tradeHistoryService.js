const Trade = require('../models/Trade');
const { asEnum } = require('../utils/validators');

const TRADE_EVENT_TYPES = ['listed', 'purchased', 'cancelled'];

const normalizeWallet = (wallet) => (wallet ? String(wallet).toLowerCase() : null);

const parsePrice = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

const buildTradeQuery = ({
  wallet = null,
  eventType = null,
  listingId = null,
  sinceDays = null,
  since = null,
  minPrice = null,
  maxPrice = null,
}) => {
  const conditions = [];
  const normalizedWallet = normalizeWallet(wallet);

  if (normalizedWallet) {
    conditions.push({
      $or: [{ seller: normalizedWallet }, { buyer: normalizedWallet }],
    });
  }

  if (eventType) {
    const safeEventType = asEnum(eventType, TRADE_EVENT_TYPES);
    if (safeEventType) {
      conditions.push({ eventType: safeEventType });
    }
  }

  if (listingId !== null && listingId !== undefined && listingId !== '') {
    conditions.push({ listingId: Number(listingId) });
  }

  if (since) {
    conditions.push({ blockTimestamp: { $gte: new Date(since) } });
  } else if (sinceDays) {
    const days = Number(sinceDays);
    if (Number.isFinite(days) && days > 0) {
      conditions.push({
        blockTimestamp: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
      });
    }
  }

  if (minPrice !== null && minPrice !== undefined && minPrice !== '') {
    conditions.push({ $expr: { $gte: [{ $toDouble: '$price' }, Number(minPrice)] } });
  }

  if (maxPrice !== null && maxPrice !== undefined && maxPrice !== '') {
    conditions.push({ $expr: { $lte: [{ $toDouble: '$price' }, Number(maxPrice)] } });
  }

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
};

const getTradeSummary = async (params = {}) => {
  const query = buildTradeQuery(params);
  const normalizedWallet = normalizeWallet(params.wallet);

  const byEvent = await Trade.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$eventType',
        count: { $sum: 1 },
        volumeCc: { $sum: { $toDouble: '$price' } },
        energy: { $sum: '$energyAmount' },
      },
    },
  ]);

  const summary = {
    total: 0,
    listed: 0,
    purchased: 0,
    cancelled: 0,
    totalVolumeCc: 0,
    totalEnergyTraded: 0,
    creditsReceived: 0,
    creditsSpent: 0,
    netFlow: 0,
  };

  byEvent.forEach((row) => {
    summary.total += row.count;
    if (row._id === 'listed') summary.listed = row.count;
    if (row._id === 'purchased') {
      summary.purchased = row.count;
      summary.totalVolumeCc += row.volumeCc || 0;
      summary.totalEnergyTraded += row.energy || 0;
    }
    if (row._id === 'cancelled') summary.cancelled = row.count;
  });

  if (normalizedWallet) {
    const purchases = await Trade.find({
      ...query,
      eventType: 'purchased',
    }).lean();

    purchases.forEach((trade) => {
      const price = parsePrice(trade.price);
      if (trade.buyer === normalizedWallet) summary.creditsSpent += price;
      if (trade.seller === normalizedWallet) summary.creditsReceived += price;
    });
    summary.netFlow = summary.creditsReceived - summary.creditsSpent;
  }

  return summary;
};

const getTradeHistory = async (params = {}) => {
  const query = buildTradeQuery(params);
  const safeLimit = Math.min(Math.max(Number(params.limit) || 50, 1), 100);
  const safePage = Math.max(Number(params.page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const [trades, total, summary] = await Promise.all([
    Trade.find(query)
      .sort({ blockTimestamp: -1, blockNumber: -1, logIndex: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    Trade.countDocuments(query),
    getTradeSummary(params),
  ]);

  return {
    trades,
    summary,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit) || 1,
    },
  };
};

const getTradeByTxHash = async (txHash) => {
  const normalizedHash = String(txHash).toLowerCase();
  const trades = await Trade.find({ txHash: normalizedHash })
    .sort({ logIndex: 1 })
    .lean();

  return trades;
};

module.exports = {
  buildTradeQuery,
  getTradeHistory,
  getTradeSummary,
  getTradeByTxHash,
  TRADE_EVENT_TYPES,
};
