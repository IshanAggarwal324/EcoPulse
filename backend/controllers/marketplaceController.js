const marketplaceService = require('../services/marketplaceService');
const asyncHandler = require('../utils/asyncHandler');

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

module.exports = {
  getOrders,
  getOrderById,
};
