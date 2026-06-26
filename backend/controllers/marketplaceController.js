const marketplaceService = require('../services/marketplaceService');
const buyOrderService = require('../services/buyOrderService');
const asyncHandler = require('../utils/asyncHandler');

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const parseSeller = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!ADDRESS_RE.test(String(raw))) return false; // signal invalid
  return String(raw).toLowerCase();
};

const getOrders = asyncHandler(async (req, res) => {
  const result = await marketplaceService.getActiveOrders({
    seller: req.query.seller || null,
    sort: req.query.sort || 'newest',
    minPrice: req.query.minPrice,
    maxPrice: req.query.maxPrice,
    page: req.query.page,
    limit: req.query.limit,
  });

  res.status(200).json({
    success: true,
    data: result,
  });
});

const getOrderById = asyncHandler(async (req, res) => {
  const listingId = parseInt(req.params.listingId, 10);
  if (Number.isNaN(listingId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid listing ID',
    });
  }

  const order = await marketplaceService.getOrderById(listingId);
  if (!order) {
    return res.status(404).json({
      success: false,
      message: 'Marketplace order not found',
    });
  }

  res.status(200).json({
    success: true,
    data: order,
  });
});

const getOrderBook = asyncHandler(async (req, res) => {
  const seller = parseSeller(req.query.seller);
  if (seller === false) {
    return res.status(400).json({ success: false, message: 'Invalid seller address' });
  }

  const data = await marketplaceService.getOrderBook({
    seller,
    buckets: req.query.buckets,
  });

  res.status(200).json({ success: true, data });
});

const getOrderBookDepth = asyncHandler(async (req, res) => {
  const seller = parseSeller(req.query.seller);
  if (seller === false) {
    return res.status(400).json({ success: false, message: 'Invalid seller address' });
  }

  const data = await marketplaceService.getOrderBookDepth({
    seller,
    buckets: req.query.buckets,
  });

  res.status(200).json({ success: true, data });
});

const getBuyOrders = asyncHandler(async (req, res) => {
  const result = await buyOrderService.listBuyOrders({
    user: req.user,
    ownerId: req.query.ownerId || null,
    status: req.query.status || null,
    page: req.query.page,
    limit: req.query.limit,
  });

  res.status(200).json({ success: true, data: result });
});

const createBuyOrder = asyncHandler(async (req, res) => {
  const { signature, maxEnergyKwh, maxUnitPriceCc, maxTotalCc, expiresAt, nonce } = req.body || {};

  const result = await buyOrderService.createBuyOrder({
    user: req.user,
    signature,
    maxEnergyKwh,
    maxUnitPriceCc,
    maxTotalCc,
    expiresAtUnix: expiresAt,
    nonce,
    req,
  });

  res.status(201).json({ success: true, data: result });
});

const cancelBuyOrder = asyncHandler(async (req, res) => {
  const result = await buyOrderService.cancelBuyOrder({
    id: req.params.id,
    user: req.user,
    reason: req.body?.reason,
    req,
  });

  res.status(200).json({ success: true, data: result });
});

module.exports = {
  getOrders,
  getOrderById,
  getOrderBook,
  getOrderBookDepth,
  getBuyOrders,
  createBuyOrder,
  cancelBuyOrder,
};
