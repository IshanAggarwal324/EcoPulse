const Trade = require('../../models/Trade');
const tradeHistoryService = require('../../services/tradeHistoryService');
const { parsePagination, paginateResults } = require('../../utils/paginate');
const asyncHandler = require('../../utils/asyncHandler');

const listTrades = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { maxLimit: 100 });
  const { eventType, seller, buyer, wallet, since, until } = req.query;

  const conditions = [];

  if (eventType) {
    conditions.push({ eventType });
  }

  if (seller) {
    conditions.push({ seller: seller.toLowerCase() });
  }

  if (buyer) {
    conditions.push({ buyer: buyer.toLowerCase() });
  }

  if (wallet) {
    const w = wallet.toLowerCase();
    conditions.push({ $or: [{ seller: w }, { buyer: w }] });
  }

  if (since) {
    conditions.push({ blockTimestamp: { $gte: new Date(since) } });
  }

  if (until) {
    conditions.push({ blockTimestamp: { $lte: new Date(until) } });
  }

  const filter = conditions.length === 0
    ? {}
    : conditions.length === 1
      ? conditions[0]
      : { $and: conditions };

  const [trades, total] = await Promise.all([
    Trade.find(filter)
      .sort({ blockTimestamp: -1, blockNumber: -1, logIndex: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Trade.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: trades,
    meta: paginateResults({ page, limit, total }),
  });
});

const getTrade = asyncHandler(async (req, res) => {
  const { txHash } = req.params;

  const trades = await tradeHistoryService.getTradeByTxHash(txHash);

  if (!trades.length) {
    return res.status(404).json({
      success: false,
      message: 'No transaction records found for this hash',
    });
  }

  res.status(200).json({
    success: true,
    data: { trades },
  });
});

module.exports = {
  listTrades,
  getTrade,
};
