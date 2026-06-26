const tradeHistoryService = require('../services/tradeHistoryService');
const tradeAggregationService = require('../services/tradeAggregationService');
const asyncHandler = require('../utils/asyncHandler');
const { WALLET_REGEX, asEnum } = require('../utils/validators');

const { TRADE_EVENT_TYPES, anonymizeWallet } = tradeHistoryService;

const TX_HASH_REGEX = /^0x[a-f0-9]{64}$/i;

const isPrivileged = (user) => user?.role === 'admin' || user?.role === 'moderator';
const selfWallet = (user) => (user?.walletAddress ? String(user.walletAddress).toLowerCase() : null);

const parseWallet = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).toLowerCase();
  return WALLET_REGEX.test(value) ? value : false;
};

const parseListingId = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : false;
};

const parsePage = (raw) => Math.max(Number(raw) || 1, 1);
const parseLimit = (raw, fallback = 50) => Math.min(Math.max(Number(raw) || fallback, 1), 100);

const badRequest = (message) => {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
};

const forbidden = (message) => {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
};

const resolveMarketplaceTradeScope = (req) => {
  const privileged = isPrivileged(req.user);
  const me = selfWallet(req.user);

  const wallet = parseWallet(req.query.wallet);
  const seller = parseWallet(req.query.seller);
  const buyer = parseWallet(req.query.buyer);

  if (wallet === false) throw badRequest('Invalid wallet address');
  if (seller === false) throw badRequest('Invalid seller address');
  if (buyer === false) throw badRequest('Invalid buyer address');

  const walletTargets = [wallet, seller, buyer].filter(Boolean);
  if (!privileged) {
    for (const target of walletTargets) {
      if (me && target === me) continue;
      throw forbidden('You can only query your own wallet trade history');
    }
  }

  const listingId = parseListingId(req.query.listingId);
  if (listingId === false) throw badRequest('Invalid listingId');

  const scoped = walletTargets.length > 0 || listingId !== null;
  if (!scoped && !privileged) {
    throw forbidden('Provide a listingId or wallet filter, or use the recent trades feed');
  }

  return { wallet, seller, buyer, listingId };
};

const anonymizeTradeForTape = (trade) => ({
  listingId: trade.listingId,
  eventType: trade.eventType,
  seller: trade.seller ? anonymizeWallet(trade.seller) : null,
  buyer: trade.buyer ? anonymizeWallet(trade.buyer) : null,
  energyAmount: trade.energyAmount,
  price: trade.price,
  blockTimestamp: trade.blockTimestamp,
  txHash: trade.txHash,
});

const parseEventType = (raw, fallback = null) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = asEnum(raw, TRADE_EVENT_TYPES);
  if (!value) throw badRequest('Invalid eventType');
  return value;
};

const getMarketplaceTrades = asyncHandler(async (req, res) => {
  const { wallet, seller, buyer, listingId } = resolveMarketplaceTradeScope(req);
  const eventType = parseEventType(req.query.eventType);

  const result = await tradeHistoryService.getTradeHistory({
    wallet,
    seller,
    buyer,
    eventType,
    listingId,
    since: req.query.since,
    sinceDays: req.query.sinceDays,
    minPrice: req.query.minPrice,
    maxPrice: req.query.maxPrice,
    page: parsePage(req.query.page),
    limit: parseLimit(req.query.limit),
  });

  res.status(200).json({ success: true, data: result });
});

const getMarketTape = asyncHandler(async (req, res) => {
  const eventType = parseEventType(req.query.eventType, 'purchased');
  const trades = await tradeHistoryService.getRecentTrades({
    eventType,
    limit: parseLimit(req.query.limit, 25),
    sinceDays: req.query.sinceDays,
  });
  const tape = trades.map(anonymizeTradeForTape);

  res.status(200).json({ success: true, data: { trades: tape } });
});

const getAggregatedTrades = asyncHandler(async (req, res) => {
  const { wallet, seller, buyer, listingId } = resolveMarketplaceTradeScope(req);
  const result = await tradeAggregationService.getAggregatedTrades({
    wallet,
    seller,
    buyer,
    listingId,
    since: req.query.since,
    sinceDays: req.query.sinceDays,
    page: parsePage(req.query.page),
    legLimit: parseLimit(req.query.legLimit ?? req.query.limit, 50),
  });

  res.status(200).json({ success: true, data: result });
});

const getMarketplaceTradeByTxHash = asyncHandler(async (req, res) => {
  const txHash = String(req.params.txHash || '').toLowerCase();
  if (!TX_HASH_REGEX.test(txHash)) throw badRequest('Invalid transaction hash');

  const trades = await tradeHistoryService.getTradeByTxHash(txHash);
  if (!trades.length) {
    return res.status(404).json({ success: false, message: 'No transaction records found for this hash' });
  }

  if (!isPrivileged(req.user)) {
    const me = selfWallet(req.user);
    const scoped = trades.filter((trade) => trade.seller === me || trade.buyer === me);
    if (!scoped.length) {
      return res.status(404).json({ success: false, message: 'No transaction records found for this hash' });
    }
    return res.status(200).json({ success: true, data: { trades: scoped } });
  }

  res.status(200).json({ success: true, data: { trades } });
});

const getExpiredListings = asyncHandler(async (req, res) => {
  const privileged = isPrivileged(req.user);
  const me = selfWallet(req.user);

  const seller = parseWallet(req.query.seller);
  if (seller === false) throw badRequest('Invalid seller address');
  if (seller && !privileged && seller !== me) {
    throw forbidden('You can only view expired listings for your own wallet');
  }

  const listingId = parseListingId(req.query.listingId);
  if (listingId === false) throw badRequest('Invalid listingId');

  const result = await tradeHistoryService.getTradeHistory({
    eventType: 'expired',
    seller,
    listingId,
    since: req.query.since,
    sinceDays: req.query.sinceDays,
    page: parsePage(req.query.page),
    limit: parseLimit(req.query.limit),
  });

  res.status(200).json({ success: true, data: result });
});

module.exports = {
  getMarketplaceTrades,
  getMarketTape,
  getAggregatedTrades,
  getMarketplaceTradeByTxHash,
  getExpiredListings,
  resolveMarketplaceTradeScope,
  anonymizeTradeForTape,
  parseWallet,
  parseListingId,
};
