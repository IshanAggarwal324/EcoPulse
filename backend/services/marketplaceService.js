const Trade = require('../models/Trade');
const BlockchainService = require('./blockchainService');
const { getCachedActiveListings } = require('./listingCache');
const { getRedisClient, isRedisAvailable } = require('../config/redis');

// Order-book depth config (Sub-module 6.1). Defaults keep the ladder compact;
// the cap prevents a client from forcing an O(n*buckets) blowup.
const DEFAULT_DEPTH_BUCKETS = parseInt(process.env.ORDERBOOK_DEPTH_BUCKETS || '20', 10);
const MAX_DEPTH_BUCKETS = parseInt(process.env.ORDERBOOK_MAX_DEPTH_BUCKETS || '50', 10);
const DEPTH_CACHE_TTL_SECONDS = parseInt(process.env.ORDERBOOK_DEPTH_CACHE_TTL || '5', 10);

const clampBuckets = (raw) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DEPTH_BUCKETS;
  return Math.min(Math.max(Math.floor(n), 1), MAX_DEPTH_BUCKETS);
};

const round6 = (n) => Math.round(n * 1e6) / 1e6;

const parsePrice = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

const getListedEvent = async (listingId) =>
  Trade.findOne({ listingId: Number(listingId), eventType: 'listed' })
    .sort({ blockNumber: -1 })
    .lean();

const enrichOrder = (listing) => {
  const energyAmount = Number(listing.energyAmount) || 0;
  const price = parsePrice(listing.price);
  const unitPrice = energyAmount > 0 ? price / energyAmount : 0;
  const createdAtSec = listing.createdAt || 0;
  const createdAt = createdAtSec
    ? new Date(createdAtSec * 1000).toISOString()
    : null;

  return {
    listingId: listing.id,
    seller: listing.seller,
    energyAmount,
    price,
    unitPrice,
    status: 'active',
    createdAt,
    listedAt: createdAt,
    txHash: null,
    blockNumber: null,
  };
};

const sortOrders = (orders, sort) => {
  const sorted = [...orders];

  switch (sort) {
    case 'price_asc':
      sorted.sort((a, b) => a.price - b.price);
      break;
    case 'price_desc':
      sorted.sort((a, b) => b.price - a.price);
      break;
    case 'energy_asc':
      sorted.sort((a, b) => a.energyAmount - b.energyAmount);
      break;
    case 'energy_desc':
      sorted.sort((a, b) => b.energyAmount - a.energyAmount);
      break;
    case 'unit_price_asc':
      sorted.sort((a, b) => a.unitPrice - b.unitPrice);
      break;
    case 'newest':
    default:
      sorted.sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      );
  }

  return sorted;
};

const getActiveOrders = async ({
  seller = null,
  sort = 'newest',
  minPrice = null,
  maxPrice = null,
  page = 1,
  limit = 50,
} = {}) => {
  const listings = await getCachedActiveListings(() => BlockchainService.getActiveListings());
  const normalizedSeller = seller ? String(seller).toLowerCase() : null;

  let filtered = listings;
  if (normalizedSeller) {
    filtered = filtered.filter((l) => l.seller.toLowerCase() === normalizedSeller);
  }

  let orders = filtered.map(enrichOrder);

  if (minPrice !== null && minPrice !== undefined) {
    orders = orders.filter((o) => o.price >= Number(minPrice));
  }
  if (maxPrice !== null && maxPrice !== undefined) {
    orders = orders.filter((o) => o.price <= Number(maxPrice));
  }

  orders = sortOrders(orders, sort);

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;
  const paginated = orders.slice(skip, skip + safeLimit);

  return {
    orders: paginated,
    summary: {
      totalActive: orders.length,
      totalEnergy: orders.reduce((sum, o) => sum + o.energyAmount, 0),
      totalVolumeCc: orders.reduce((sum, o) => sum + o.price, 0),
      avgUnitPrice:
        orders.length > 0
          ? orders.reduce((sum, o) => sum + o.unitPrice, 0) / orders.length
          : 0,
    },
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: orders.length,
      pages: Math.ceil(orders.length / safeLimit) || 1,
    },
  };
};

/**
 * Order-book depth metrics exposed to the pricing engine (Sub-module 2.4.1).
 *
 * The EcoPulse marketplace is sell-listing based (no standing buy orders), so
 * the active order book represents live *supply*. The pricing engine blends this
 * depth into its surplus-pressure calculation and uses the book's average asking
 * unit price as a real-time market anchor alongside historical trade analytics.
 *
 * Returns a normalized, finite-valued snapshot so a transient chain/RPC outage
 * (which surfaces as an empty/throwing getActiveOrders) degrades to a zero-depth
 * signal rather than poisoning the pricing curve.
 */
const getMarketDepth = async ({ seller = null } = {}) => {
  let summary = null;
  let orders = null;
  try {
    ({ summary, orders } = await getActiveOrders({ seller, limit: 100 }));
  } catch {
    // Chain/RPC outage: degrade to a zero-depth snapshot so the pricing engine's
    // feedback loop never throws (defense in depth; the engine also wraps this).
    summary = null;
    orders = [];
  }

  const listingCount = Number.isFinite(summary?.totalActive) ? summary.totalActive : 0;
  const totalEnergyKw = Number.isFinite(summary?.totalEnergy) ? summary.totalEnergy : 0;
  const totalVolumeCc = Number.isFinite(summary?.totalVolumeCc) ? summary.totalVolumeCc : 0;
  const avgUnitPriceCc = Number.isFinite(summary?.avgUnitPrice) ? summary.avgUnitPrice : 0;

  // Asking spread — tightens the anchor signal even further. Both fall back to
  // 0 when the book is empty so the pricing engine can detect "no market".
  let minUnitPriceCc = 0;
  let maxUnitPriceCc = 0;
  if (Array.isArray(orders) && orders.length > 0) {
    const units = orders
      .map((o) => Number(o.unitPrice))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (units.length > 0) {
      minUnitPriceCc = Math.min(...units);
      maxUnitPriceCc = Math.max(...units);
    }
  }

  return {
    listingCount,
    totalEnergyKw,
    totalVolumeCc,
    avgUnitPriceCc,
    minUnitPriceCc,
    maxUnitPriceCc,
    hasDepth: listingCount > 0,
    computedAt: new Date().toISOString(),
  };
};

const getOrderById = async (listingId) => {
  const listing = await BlockchainService.getListingById(listingId);
  if (!listing) {
    return null;
  }

  const tradeEvents = await Trade.find({
    listingId: Number(listing.id),
    eventType: { $in: ['listed', 'purchased', 'cancelled'] },
  })
    .sort({ blockNumber: -1 })
    .lean();

  const listedEvent = tradeEvents.find((event) => event.eventType === 'listed');
  const purchasedEvent = tradeEvents.find((event) => event.eventType === 'purchased');
  const cancelledEvent = tradeEvents.find((event) => event.eventType === 'cancelled');

  const energyAmount = Number(listing.energyAmount) || 0;
  const price = parsePrice(listing.price);

  return {
    listingId: listing.id,
    seller: listing.seller,
    energyAmount,
    price,
    unitPrice: energyAmount > 0 ? price / energyAmount : 0,
    status: listing.status,
    isActive: listing.isActive,
    createdAt: listing.createdAt
      ? new Date(listing.createdAt * 1000).toISOString()
      : listedEvent?.blockTimestamp || null,
    listedAt: listedEvent?.blockTimestamp || null,
    purchasedAt: purchasedEvent?.blockTimestamp || null,
    cancelledAt: cancelledEvent?.blockTimestamp || null,
    txHash: listedEvent?.txHash || null,
    purchaseTxHash: purchasedEvent?.txHash || null,
  };
};

/**
 * Aggregate sell-side orders into a price-level (asks) ladder.
 *
 * Pure function (no I/O) so it is cheap to unit-test. Orders carry a `unitPrice`
 * (CC per kWh). When `buckets` > 1 and the unit-price range is non-trivial, the
 * range is divided into equal-width buckets; otherwise each distinct unit price
 * is its own level. Each level carries energy, listing count, CC volume and a
 * cumulative depth (ascending price) for depth-chart rendering.
 */
const aggregateAsks = (orders, { buckets: rawBuckets } = {}) => {
  const safe = Array.isArray(orders) ? orders : [];
  const finite = safe
    .map((o) => ({ unitPrice: Number(o?.unitPrice), energy: Number(o?.energyAmount) || 0, price: Number(o?.price) || 0 }))
    .filter((o) => Number.isFinite(o.unitPrice) && o.unitPrice >= 0);

  if (finite.length === 0) {
    return {
      levels: [],
      bestAskUnitPriceCc: 0,
      worstAskUnitPriceCc: 0,
      totalEnergyKw: 0,
      totalVolumeCc: 0,
      listingCount: 0,
    };
  }

  const buckets = clampBuckets(rawBuckets);
  const minUnit = Math.min(...finite.map((o) => o.unitPrice));
  const maxUnit = Math.max(...finite.map((o) => o.unitPrice));
  const span = maxUnit - minUnit;

  const useBuckets = buckets > 1 && span > 0 && finite.length > buckets;
  const step = useBuckets ? span / buckets : 0;

  const acc = new Map();
  let totalEnergy = 0;
  let totalVolume = 0;

  for (const o of finite) {
    let key;
    if (useBuckets) {
      const idx = Math.min(buckets - 1, Math.floor((o.unitPrice - minUnit) / step));
      const lo = round6(minUnit + idx * step);
      key = lo;
    } else {
      key = round6(o.unitPrice);
    }

    const entry = acc.get(key) || { unitPriceCc: key, energyKw: 0, listingCount: 0, volumeCc: 0 };
    entry.energyKw += o.energy;
    entry.listingCount += 1;
    entry.volumeCc += o.price;
    acc.set(key, entry);

    totalEnergy += o.energy;
    totalVolume += o.price;
  }

  const levels = [...acc.values()]
    .sort((a, b) => a.unitPriceCc - b.unitPriceCc)
    .map((lvl) => ({
      unitPriceCc: round6(lvl.unitPriceCc),
      energyKw: round6(lvl.energyKw),
      listingCount: lvl.listingCount,
      volumeCc: round6(lvl.volumeCc),
    }));

  let cumulative = 0;
  for (const lvl of levels) {
    cumulative += lvl.energyKw;
    lvl.cumulativeEnergyKw = round6(cumulative);
  }

  return {
    levels,
    bestAskUnitPriceCc: round6(minUnit),
    worstAskUnitPriceCc: round6(maxUnit),
    totalEnergyKw: round6(totalEnergy),
    totalVolumeCc: round6(totalVolume),
    listingCount: finite.length,
  };
};

// Depth-result cache (memory + redis). The underlying listing cache already
// removes the O(n) RPC scan; this cache additionally avoids recomputing the
// ladder on burst requests against a hot endpoint.
let depthMemoryCache = new Map(); // key -> { at, data }
// In-process registry of the depth-cache keys we've written, so invalidation
// can DEL exactly those keys (Redis KEYS/SCAN is avoided — it blocks the event
// loop and is unsafe on a shared, large keyspace).
const depthCacheKeySet = new Set();
const MAX_TRACKED_DEPTH_KEYS = 256;
const depthCacheKey = ({ seller, buckets }) => {
  const k = `marketplace:orderbook_depth:v1:${seller ? String(seller).toLowerCase() : 'all'}:${buckets}`;
  if (depthCacheKeySet.size >= MAX_TRACKED_DEPTH_KEYS) depthCacheKeySet.clear();
  depthCacheKeySet.add(k);
  return k;
};

const depthIsFresh = (at) => Date.now() - at < DEPTH_CACHE_TTL_SECONDS * 1000;

const getCachedDepth = async (key, computeFn) => {
  const mem = depthMemoryCache.get(key);
  if (mem && depthIsFresh(mem.at)) return mem.data;

  if (isRedisAvailable()) {
    try {
      const raw = await getRedisClient().get(`depth:${key}`);
      if (raw) {
        const data = JSON.parse(raw);
        depthMemoryCache.set(key, { at: Date.now(), data });
        return data;
      }
    } catch {
      // fall through to compute
    }
  }

  const data = await computeFn();
  depthMemoryCache.set(key, { at: Date.now(), data });
  if (isRedisAvailable()) {
    try {
      await getRedisClient().set(`depth:${key}`, JSON.stringify(data), 'EX', DEPTH_CACHE_TTL_SECONDS);
    } catch {
      // cache write is best-effort
    }
  }
  return data;
};

/**
 * Invalidate the depth ladder cache (called when listings change). Avoids
 * serving a stale book after a sync pass or purchase. Deletes only the keys we
 * tracked (never scans Redis); a short TTL self-heals any missed key.
 */
const invalidateOrderBookDepthCache = () => {
  depthMemoryCache.clear();
  if (!isRedisAvailable() || depthCacheKeySet.size === 0) {
    depthCacheKeySet.clear();
    return;
  }
  const keys = [...depthCacheKeySet].map((k) => `depth:${k}`);
  depthCacheKeySet.clear();
  getRedisClient()
    .del(keys)
    .catch(() => {});
};

/**
 * Full order book: active sell listings (asks) + aggregated asks ladder.
 * (Sub-module 6.1.1/6.1.2)
 */
const getOrderBook = async ({ seller = null, buckets = DEFAULT_DEPTH_BUCKETS } = {}) => {
  let orders = [];
  let summary = null;
  try {
    ({ orders, summary } = await getActiveOrders({ seller, limit: 100 }));
  } catch {
    // Chain/RPC outage: degrade to an empty asks side rather than 500-ing a
    // hot read endpoint (defense in depth; matches getMarketDepth behavior).
    orders = [];
    summary = null;
  }
  const asks = aggregateAsks(orders, { buckets });
  return {
    asks: {
      orders,
      levels: asks.levels,
      bestAskUnitPriceCc: asks.bestAskUnitPriceCc,
      worstAskUnitPriceCc: asks.worstAskUnitPriceCc,
      listingCount: asks.listingCount,
    },
    summary,
    computedAt: new Date().toISOString(),
  };
};

/**
 * Aggregated depth ladder: asks (sell supply) + bids (buy demand). Cached for
 * DEPTH_CACHE_TTL_SECONDS to protect the hot endpoint. (Sub-module 6.1.2/6.1.5)
 */
const getOrderBookDepth = async ({ seller = null, buckets = DEFAULT_DEPTH_BUCKETS } = {}) => {
  const safeBuckets = clampBuckets(buckets);
  const cacheKey = depthCacheKey({ seller, buckets: safeBuckets });

  return getCachedDepth(cacheKey, async () => {
    let orders = [];
    try {
      ({ orders } = await getActiveOrders({ seller, limit: 100 }));
    } catch {
      orders = [];
    }
    const asks = aggregateAsks(orders, { buckets: safeBuckets });

    let bids = null;
    try {
      const { getActiveBuyDepth } = require('./buyOrderService');
      bids = await getActiveBuyDepth();
    } catch {
      // Buy-side is optional; degrade to asks-only if unavailable.
      bids = {
        levels: [],
        bidCount: 0,
        totalDemandEnergy: 0,
        totalDemandVolumeCc: 0,
        bestBidUnitPriceCc: 0,
        computedAt: new Date().toISOString(),
      };
    }

    const spreadCc =
      asks.bestAskUnitPriceCc > 0 && bids.bestBidUnitPriceCc > 0
        ? round6(asks.bestAskUnitPriceCc - bids.bestBidUnitPriceCc)
        : null;

    return {
      asks: {
        levels: asks.levels,
        bestAskUnitPriceCc: asks.bestAskUnitPriceCc,
        worstAskUnitPriceCc: asks.worstAskUnitPriceCc,
        totalEnergyKw: asks.totalEnergyKw,
        totalVolumeCc: asks.totalVolumeCc,
        listingCount: asks.listingCount,
      },
      bids: {
        levels: bids.levels,
        bestBidUnitPriceCc: bids.bestBidUnitPriceCc,
        bidCount: bids.bidCount,
        totalDemandEnergy: bids.totalDemandEnergy,
        totalDemandVolumeCc: bids.totalDemandVolumeCc,
      },
      spreadCc,
      midUnitPriceCc:
        asks.bestAskUnitPriceCc > 0 && bids.bestBidUnitPriceCc > 0
          ? round6((asks.bestAskUnitPriceCc + bids.bestBidUnitPriceCc) / 2)
          : asks.bestAskUnitPriceCc || bids.bestBidUnitPriceCc || 0,
      computedAt: new Date().toISOString(),
    };
  });
};

module.exports = {
  getActiveOrders,
  getMarketDepth,
  getOrderById,
  getOrderBook,
  getOrderBookDepth,
  aggregateAsks,
  clampBuckets,
  invalidateOrderBookDepthCache,
};
