const Trade = require('../models/Trade');

const normalizeWallet = (wallet) => (wallet ? String(wallet).toLowerCase() : null);

const getTradeHistory = async ({
  wallet = null,
  eventType = null,
  listingId = null,
  limit = 50,
  page = 1,
}) => {
  const query = {};
  const normalizedWallet = normalizeWallet(wallet);

  if (normalizedWallet) {
    query.$or = [
      { seller: normalizedWallet },
      { buyer: normalizedWallet },
    ];
  }

  if (eventType) {
    query.eventType = eventType;
  }

  if (listingId !== null && listingId !== undefined) {
    query.listingId = Number(listingId);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const [trades, total] = await Promise.all([
    Trade.find(query)
      .sort({ blockTimestamp: -1, blockNumber: -1, logIndex: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    Trade.countDocuments(query),
  ]);

  return {
    trades,
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
  getTradeHistory,
  getTradeByTxHash,
};
