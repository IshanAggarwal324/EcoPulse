const Trade = require('../models/Trade');
const { asEnum, WALLET_REGEX } = require('../utils/validators');

const TRADE_EVENT_TYPES = ['listed', 'purchased', 'cancelled', 'expired'];

const normalizeWallet = (wallet) => (wallet ? String(wallet).toLowerCase() : null);

const parsePrice = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

const buildTradeQuery = ({
  wallet = null,
  eventType = null,
  listingId = null,
  seller = null,
  buyer = null,
  sinceDays = null,
  since = null,
  minPrice = null,
  maxPrice = null,
}) => {
  const conditions = [];
  const normalizedWallet = normalizeWallet(wallet);
  const normalizedSeller = normalizeWallet(seller);
  const normalizedBuyer = normalizeWallet(buyer);

  if (normalizedWallet) {
    conditions.push({
      $or: [{ seller: normalizedWallet }, { buyer: normalizedWallet }],
    });
  }

  if (normalizedSeller) {
    conditions.push({ seller: normalizedSeller });
  }

  if (normalizedBuyer) {
    conditions.push({ buyer: normalizedBuyer });
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
    expired: 0,
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
    if (row._id === 'expired') summary.expired = row.count;
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

const anonymizeWallet = (wallet) => {
  if (!wallet || typeof wallet !== 'string') return null;
  const w = wallet.toLowerCase();
  if (!WALLET_REGEX.test(w)) return null;
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
};

const getRecentTrades = async ({ eventType = 'purchased', limit = 25, sinceDays = null } = {}) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const query = { eventType: asEnum(eventType, TRADE_EVENT_TYPES) || 'purchased' };
  if (sinceDays) {
    const days = Number(sinceDays);
    if (Number.isFinite(days) && days > 0) {
      query.blockTimestamp = { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
    }
  }
  const trades = await Trade.find(query)
    .sort({ blockTimestamp: -1, blockNumber: -1, logIndex: -1 })
    .limit(safeLimit)
    .lean();

  return trades;
};

const toIsoTs = (value) => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
};

/**
 * Module 9.4 — shape a raw trade (DB doc OR realtime contract-event payload)
 * into the compact, SANITIZED, ANONYMIZED item used by the live trade ticker
 * and the GET /trades/recent seed endpoint.
 *
 * Security:
 *  - seller/buyer are anonymized (0x1234…abcd). The ticker is a global feed
 *    shown to all authenticated users; we never broadcast full wallet PII.
 *  - every field is type-coerced so a malformed on-chain/log payload can never
 *    push oversized or garbage data to connected clients.
 *  - `id` derives from txHash:logIndex (stable dedup vs. the seed); falls back
 *    to a live composite so realtime events always dedup-safe.
 *
 * Returns null for non-object input so callers can drop junk silently.
 */
const shapeTradeTickerItem = (trade) => {
  if (!trade || typeof trade !== 'object') return null;

  const sellerAnon = anonymizeWallet(trade.seller);
  const buyerAnon = anonymizeWallet(trade.buyer);
  const txHash = typeof trade.txHash === 'string' ? trade.txHash.toLowerCase() : '';
  const logIndex = Number(trade.logIndex);
  const hasLogIndex = Number.isInteger(logIndex) && logIndex >= 0;

  // A ticker item must carry a real counterparty (or a stable on-chain ref).
  // Anything else is junk — drop it so malformed payloads never reach clients.
  if (!sellerAnon && !buyerAnon && !(txHash && hasLogIndex)) return null;

  const id = txHash && hasLogIndex
    ? `${txHash}:${logIndex}`
    : `live:${trade.listingId ?? 'x'}:${toIsoTs(trade.blockTimestamp ?? trade.ts)}`;

  const kwh = Number(trade.energyAmount);
  const priceStr = typeof trade.price === 'string' || typeof trade.price === 'number'
    ? String(trade.price)
    : '0';
  const priceNum = parseFloat(priceStr);
  const safePriceNum = Number.isFinite(priceNum) ? priceNum : 0;
  const safeKwh = Number.isFinite(kwh) ? kwh : 0;
  const listingIdNum = Number(trade.listingId);

  return {
    id,
    listingId: Number.isInteger(listingIdNum) && listingIdNum >= 0 ? listingIdNum : null,
    seller: sellerAnon,
    buyer: buyerAnon,
    kwh: safeKwh,
    price: safePriceNum.toString(),
    pricePerKwh: safeKwh > 0 ? Number((safePriceNum / safeKwh).toFixed(6)) : 0,
    ts: toIsoTs(trade.blockTimestamp ?? trade.ts),
  };
};

module.exports = {
  buildTradeQuery,
  getTradeHistory,
  getTradeSummary,
  getTradeByTxHash,
  getRecentTrades,
  anonymizeWallet,
  shapeTradeTickerItem,
  TRADE_EVENT_TYPES,
};
