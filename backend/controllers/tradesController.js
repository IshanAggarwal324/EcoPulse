const tradeHistoryService = require('../services/tradeHistoryService');
const blockchainSyncService = require('../services/blockchainSyncService');
const asyncHandler = require('../utils/asyncHandler');

const isPrivileged = (user) => user?.role === 'admin' || user?.role === 'moderator';

const resolveWalletScope = (req) => {
  const requestedWallet = req.query.wallet ? String(req.query.wallet).toLowerCase() : null;

  if (isPrivileged(req.user)) {
    return requestedWallet;
  }

  const userWallet = req.user?.walletAddress ? String(req.user.walletAddress).toLowerCase() : null;
  if (!userWallet) {
    const err = new Error('Wallet address is required for this account');
    err.statusCode = 400;
    throw err;
  }

  if (requestedWallet && requestedWallet !== userWallet) {
    const err = new Error('You can only access trade history for your own wallet');
    err.statusCode = 403;
    throw err;
  }

  return userWallet;
};

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
  const wallet = resolveWalletScope(req);
  const result = await tradeHistoryService.getTradeHistory({
    ...parseHistoryParams(req.query),
    wallet,
  });

  res.status(200).json({
    success: true,
    data: result,
  });
});

const getByTxHash = asyncHandler(async (req, res) => {
  const trades = await tradeHistoryService.getTradeByTxHash(req.params.txHash);
  const wallet = resolveWalletScope(req);
  const scopedTrades = wallet
    ? trades.filter((trade) => trade.seller === wallet || trade.buyer === wallet)
    : trades;

  if (!scopedTrades.length) {
    return res.status(404).json({
      success: false,
      message: 'No transaction records found for this hash',
    });
  }

  res.status(200).json({
    success: true,
    data: { trades: scopedTrades },
  });
});

const syncAndGetHistory = asyncHandler(async (req, res) => {
  const sync = await blockchainSyncService.syncBlockchainTrades();
  const wallet = resolveWalletScope(req);
  const result = await tradeHistoryService.getTradeHistory({
    ...parseHistoryParams(req.query),
    wallet,
  });

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
