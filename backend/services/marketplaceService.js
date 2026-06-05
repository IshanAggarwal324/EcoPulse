const Trade = require('../models/Trade');
const BlockchainService = require('./blockchainService');

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
  const listings = await BlockchainService.getActiveListings();
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

const getOrderById = async (listingId) => {
  const listing = await BlockchainService.getListingById(listingId);
  if (!listing) {
    return null;
  }

  const listedEvent = await getListedEvent(listing.id);
  const purchasedEvent = await Trade.findOne({
    listingId: Number(listing.id),
    eventType: 'purchased',
  }).lean();
  const cancelledEvent = await Trade.findOne({
    listingId: Number(listing.id),
    eventType: 'cancelled',
  }).lean();

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

module.exports = {
  getActiveOrders,
  getOrderById,
};
