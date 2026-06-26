const Trade = require('../models/Trade');

const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;
const MAX_AGG_ROWS = 5000;

const toNumber = (value, fallback = 0) => {
  const num = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
};

const normalizeWallet = (wallet) => (wallet ? String(wallet).toLowerCase() : null);

const buildAggregationFilter = ({ wallet = null, seller = null, buyer = null, listingId = null } = {}) => {
  const conditions = [];
  const w = normalizeWallet(wallet);
  const s = normalizeWallet(seller);
  const b = normalizeWallet(buyer);

  if (w) conditions.push({ $or: [{ seller: w }, { buyer: w }] });
  if (s) conditions.push({ seller: s });
  if (b) conditions.push({ buyer: b });
  if (listingId !== null && listingId !== undefined && listingId !== '') {
    conditions.push({ listingId: Number(listingId) });
  }

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
};

const resolveSince = (since, sinceDays) => {
  if (since) {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) return d;
  }
  let days = DEFAULT_WINDOW_DAYS;
  if (sinceDays) {
    const n = Number(sinceDays);
    if (Number.isFinite(n) && n > 0) days = Math.min(n, MAX_WINDOW_DAYS);
  }
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
};

const buildLeg = (listingId, fills, listedRow = null) => {
  const fillCount = fills.length;
  let totalEnergy = 0;
  let totalVolumeCc = 0;
  let minUnit = null;
  let maxUnit = null;
  const buyerSet = new Set();

  for (const fill of fills) {
    const energy = toNumber(fill.energyAmount);
    const price = toNumber(fill.price);
    totalEnergy += energy;
    totalVolumeCc += price;
    if (energy > 0) {
      const unit = price / energy;
      if (minUnit === null || unit < minUnit) minUnit = unit;
      if (maxUnit === null || unit > maxUnit) maxUnit = unit;
    }
    if (fill.buyer) buyerSet.add(String(fill.buyer).toLowerCase());
  }

  const avgPrice = totalEnergy > 0 ? totalVolumeCc / totalEnergy : 0;
  const sorted = [...fills].sort((a, b) => {
    const ta = a.blockTimestamp ? new Date(a.blockTimestamp).getTime() : 0;
    const tb = b.blockTimestamp ? new Date(b.blockTimestamp).getTime() : 0;
    return ta - tb;
  });
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const listedEnergy = listedRow ? toNumber(listedRow.energyAmount) : null;
  const fillRate = listedRow && listedEnergy > 0 ? Math.min(totalEnergy / listedEnergy, 1) : null;
  const buyers = [...buyerSet];

  return {
    listingId: Number(listingId),
    fillCount,
    totalEnergy,
    totalVolumeCc,
    avgPrice,
    minUnitPrice: minUnit,
    maxUnitPrice: maxUnit,
    seller: first && first.seller ? String(first.seller).toLowerCase() : null,
    buyers,
    buyerCount: buyers.length,
    firstFillAt: first ? first.blockTimestamp : null,
    lastFillAt: last ? last.blockTimestamp : null,
    listedEnergy,
    fillRate,
  };
};

const aggregateLegs = (purchaseRows = [], listedRows = []) => {
  const listedByListing = new Map();
  for (const listed of listedRows) {
    listedByListing.set(Number(listed.listingId), listed);
  }

  const byListing = new Map();
  for (const purchase of purchaseRows) {
    const id = Number(purchase.listingId);
    if (!Number.isFinite(id)) continue;
    if (!byListing.has(id)) byListing.set(id, []);
    byListing.get(id).push(purchase);
  }

  const legs = [];
  for (const [id, fills] of byListing) {
    legs.push(buildLeg(id, fills, listedByListing.get(id)));
  }

  legs.sort((a, b) => {
    const ta = a.lastFillAt ? new Date(a.lastFillAt).getTime() : 0;
    const tb = b.lastFillAt ? new Date(b.lastFillAt).getTime() : 0;
    return tb - ta;
  });

  return legs;
};

const summarizeLegs = (legs = []) => {
  let totalFills = 0;
  let totalEnergy = 0;
  let totalVolumeCc = 0;
  let fullyFilledCount = 0;

  for (const leg of legs) {
    totalFills += leg.fillCount;
    totalEnergy += leg.totalEnergy;
    totalVolumeCc += leg.totalVolumeCc;
    if (leg.fillRate !== null && leg.fillRate >= 1) fullyFilledCount += 1;
  }

  return {
    legCount: legs.length,
    totalFills,
    totalEnergy,
    totalVolumeCc,
    avgPrice: totalEnergy > 0 ? totalVolumeCc / totalEnergy : 0,
    fullyFilledCount,
  };
};

const getAggregatedTrades = async (params = {}) => {
  const safePage = Math.max(Number(params.page) || 1, 1);
  const safeLegLimit = Math.min(Math.max(Number(params.legLimit ?? params.limit ?? 50), 1), 100);
  const since = resolveSince(params.since, params.sinceDays);
  const baseFilter = buildAggregationFilter(params);
  const purchaseQuery = { ...baseFilter, eventType: 'purchased', blockTimestamp: { $gte: since } };

  const purchases = await Trade.find(purchaseQuery)
    .sort({ blockTimestamp: -1, blockNumber: -1, logIndex: -1 })
    .limit(MAX_AGG_ROWS + 1)
    .lean();

  const windowTruncated = purchases.length > MAX_AGG_ROWS;
  const bounded = windowTruncated ? purchases.slice(0, MAX_AGG_ROWS) : purchases;

  const listingIds = [...new Set(bounded.map((p) => Number(p.listingId)).filter((n) => Number.isFinite(n)))];
  const listedRows = listingIds.length
    ? await Trade.find({ listingId: { $in: listingIds }, eventType: 'listed' }).lean()
    : [];

  const legs = aggregateLegs(bounded, listedRows);
  const total = legs.length;
  const pages = Math.ceil(total / safeLegLimit) || 1;
  const start = (safePage - 1) * safeLegLimit;
  const pagedLegs = legs.slice(start, start + safeLegLimit);
  const summary = summarizeLegs(legs);

  return {
    legs: pagedLegs,
    summary,
    pagination: { page: safePage, limit: safeLegLimit, total, pages },
    window: { since, windowTruncated, maxRows: MAX_AGG_ROWS },
  };
};

module.exports = {
  aggregateLegs,
  buildLeg,
  summarizeLegs,
  getAggregatedTrades,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  MAX_AGG_ROWS,
};
