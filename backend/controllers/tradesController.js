const tradeHistoryService = require('../services/tradeHistoryService');
const blockchainSyncService = require('../services/blockchainSyncService');
const asyncHandler = require('../utils/asyncHandler');

const parseHistoryParams = (query) => ({
  wallet: query.wallet,
  eventType: query.eventType,
  listingId: query.listingId,
  limit: query.limit,
  page: query.page,
  sinceDays: query.sinceDays,
  since: query.since,
  minPrice: query.minPrice,
  maxPrice: query.maxPrice,
});

const getHistory = asyncHandler(async (req, res) => {
  const result = await tradeHistoryService.getTradeHistory(parseHistoryParams(req.query));

  res.status(200).json({
    success: true,
    data: result,
  });
});

const getByTxHash = asyncHandler(async (req, res) => {
  const trades = await tradeHistoryService.getTradeByTxHash(req.params.txHash);

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

const syncAndGetHistory = asyncHandler(async (req, res) => {
  const sync = await blockchainSyncService.syncBlockchainTrades();
  const result = await tradeHistoryService.getTradeHistory(parseHistoryParams(req.query));

  res.status(200).json({
    success: true,
    data: { sync, ...result },
  });
});

module.exports = {
  getHistory,
  getByTxHash,
  syncAndGetHistory,
};
